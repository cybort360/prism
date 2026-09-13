// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";

/// @notice Option A of the Allowance Module gate: deploy Safe's **exact** released v1.0.0 code to a
///         chain where Safe has not deployed it, and record it as Prism-deployed upstream code.
///
/// This deploys the canonical **runtime bytecode** verbatim — the bytes read straight off
/// `0x691f59471Bfd2B7d639DCF74671a2d648ED1E331`, byte-identical on Optimism and Gnosis — wrapped in
/// a twelve-byte initcode that does nothing but return them. The result is a contract whose
/// `eth_getCode` is *identical* to Safe's own deployment, which is a stronger claim than "we
/// recompiled the source and believe it matches".
///
/// Why not recompile and deploy that? Because it would not be the same bytes. Compiling the tagged
/// source with Foundry (solc 0.7.6, optimizer off, per upstream's CHANGELOG) produces an identical
/// 19-function ABI but a 48-byte-larger function dispatcher — a codegen difference from upstream's
/// Hardhat toolchain that we could not close. Deploying the canonical runtime sidesteps the question
/// entirely: there is nothing to reproduce, only bytes to copy. See
/// `vendor/safe-allowances-v1.0.0/PROVENANCE.md`.
///
/// This is only sound because the module has **no constructor and no immutables** — all of its
/// state lives in mappings that start empty. A runtime-only deployment is therefore behaviourally
/// identical to a normal one, which `AllowanceModuleCompat.t.sol` exercises directly by `vm.etch`ing
/// these same bytes and running the full security matrix against them.
///
/// Run:
///   forge script script/DeployAllowanceModuleV1.s.sol --rpc-url $MONAD_RPC_URL --broadcast
///
/// Then, and only then:
///   cd tools/circles && node verify-allowance-module.mjs --module <deployed address>
///   export CIRCLE_ALLOWANCE_MODULE=<deployed address> CIRCLE_LIMITS_ENABLED=true
///
/// The gate is what authorizes the switch, not this script. Deploying proves nothing on its own.
contract DeployAllowanceModuleV1 is Script {
    /// keccak256 of the canonical v1.0.0 runtime bytecode.
    bytes32 internal constant CANONICAL_CODEHASH = 0xfafc86ce3000fbdc8ad155875c0b3b5a20d17662e7c2cdbf3e95f15945a46657;
    uint256 internal constant CANONICAL_LENGTH = 15504;

    function run() external {
        bytes memory runtime = vm.parseBytes(vm.readFile("vendor/safe-allowances-v1.0.0/canonical-runtime.hex"));

        // Refuse before broadcasting anything if the vendored bytes are not the canonical ones.
        require(runtime.length == CANONICAL_LENGTH, "vendored runtime has the wrong length");
        require(keccak256(runtime) == CANONICAL_CODEHASH, "vendored runtime is not the canonical v1.0.0 code");

        vm.startBroadcast();
        address module = _deployRuntime(runtime);
        vm.stopBroadcast();

        // Read it back from the chain rather than trusting the deployment call.
        require(module.code.length == CANONICAL_LENGTH, "deployed code has the wrong length");
        require(keccak256(module.code) == CANONICAL_CODEHASH, "deployed code is not byte-identical to canonical");

        console2.log("AllowanceModule v1.0.0 (exact upstream runtime) deployed at:", module);
        console2.log("codeHash verified identical to Safe's own deployment.");
        console2.log("Next: run tools/circles/verify-allowance-module.mjs against this address.");
    }

    /// @dev Deploys `runtime` verbatim. The initcode is twelve bytes that copy the trailing runtime
    ///      into memory and return it:
    ///        PUSH2 <len> DUP1 PUSH1 0x0c PUSH1 0x00 CODECOPY PUSH1 0x00 RETURN
    function _deployRuntime(bytes memory runtime) internal returns (address deployed) {
        require(runtime.length <= type(uint16).max, "runtime too large for this initcode shape");
        bytes memory initCode = abi.encodePacked(
            hex"61", uint16(runtime.length), hex"80600c6000396000f3", runtime
        );
        assembly {
            deployed := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(deployed != address(0), "deployment failed");
    }
}
