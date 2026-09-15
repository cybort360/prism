// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ISafe, ISafeProxyFactory, SafeOperation} from "../../src/circles/interfaces/ISafe.sol";
import {PrismP256SafeOwner} from "../../src/circles/PrismP256SafeOwner.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";

/// @notice Emits the canonical Safe-transaction test vectors for Prism Circles.
///
///         The authority for every `safeTxHash` here is a REAL Safe v1.4.1 proxy on a Monad
///         testnet fork answering `getTransactionHash(...)`. Nothing recomputes the digest in
///         Solidity — the chain is asked directly. Two independent implementations are then held
///         to this file:
///
///           1. the official Safe protocol-kit package (script/circles/verify-vectors.mjs)
///           2. the Swift calculator shipped to the iPhone (ios/Prism/Core/Circles)
///
///         Run: FOUNDRY_PROFILE=circles forge test --match-contract CircleSafeTxVectors --network monad
contract CircleSafeTxVectorsTest is Test {
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    address internal constant USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;

    string internal constant OUT = "../proof/circles/safe-tx-vectors.json";

    ISafeProxyFactory internal factory = ISafeProxyFactory(SAFE_PROXY_FACTORY);
    PrismP256SafeOwner internal p256Owner;
    address internal meraOwner = vm.addr(0xA11CE);

    struct Case {
        string name;
        address safe;
        uint256 chainId;
        address to;
        uint256 value;
        bytes data;
        SafeOperation operation;
        uint256 nonce;
        string humanRecipient;
        string amountDisplay;
    }

    function setUp() public {
        vm.createSelectFork(_rpc());
        (uint256 qx, uint256 qy) = _pubkey(0);
        p256Owner = new PrismP256SafeOwner(qx, qy);
    }

    function _rpc() internal view returns (string memory) {
        try vm.envString("MONAD_TESTNET_RPC_URL") returns (string memory url) {
            return url;
        } catch {
            return "https://testnet-rpc.monad.xyz";
        }
    }

    function _pubkey(uint256 index) internal returns (uint256 x, uint256 y) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "script/circles/p256-sign.mjs";
        cmd[2] = "pubkey";
        cmd[3] = vm.toString(index);
        (x, y) = abi.decode(vm.ffi(cmd), (uint256, uint256));
    }

    function _signP256(uint256 index, bytes32 hash) internal returns (bytes memory sig) {
        string[] memory cmd = new string[](5);
        cmd[0] = "node";
        cmd[1] = "script/circles/p256-sign.mjs";
        cmd[2] = "sign";
        cmd[3] = vm.toString(index);
        cmd[4] = vm.toString(hash);
        sig = vm.ffi(cmd);
    }

    /// @dev Deterministic per (owner, salt) via CREATE2, so vectors are reproducible run to run.
    function _safeAt(address owner, uint256 salt) internal returns (ISafe) {
        return _createSafe(owner, salt);
    }

    /// @dev The single place that asks the chain what a Safe transaction hashes to.
    function _derive(Case memory c)
        internal
        returns (bytes32 safeTxHash, bytes memory preimage, bytes32 domain)
    {
        uint256 original = block.chainid;
        vm.chainId(c.chainId);
        safeTxHash = ISafe(c.safe).getTransactionHash(
            c.to, c.value, c.data, c.operation, 0, 0, 0, address(0), address(0), c.nonce
        );
        preimage = ISafe(c.safe).encodeTransactionData(
            c.to, c.value, c.data, c.operation, 0, 0, 0, address(0), address(0), c.nonce
        );
        domain = ISafe(c.safe).domainSeparator();
        vm.chainId(original);
        assertEq(keccak256(preimage), safeTxHash, "preimage/hash disagreement inside Safe");
    }

    function _createSafe(address owner, uint256 salt) internal returns (ISafe safe) {
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory initializer = abi.encodeCall(
            ISafe.setup,
            (owners, 1, address(0), "", SAFE_FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );
        safe = ISafe(factory.createProxyWithNonce(SAFE_SINGLETON, initializer, salt));
    }

    /// @notice Default mode: re-derive every committed vector from the live Safe and assert the
    ///         checked-in file still describes reality. Set WRITE_CIRCLE_VECTORS=1 to regenerate.
    /// @dev The P-256 signature is not compared: ECDSA picks a fresh nonce per signature, so the
    ///      bytes legitimately differ every run. It is instead re-verified against the owner
    ///      contract in `_emit`, and the committed one is re-verified here.
    function test_CommittedVectorsStillMatchTheChain() public {
        if (vm.envOr("WRITE_CIRCLE_VECTORS", uint256(0)) == 1) {
            _generate();
            return;
        }
        string memory json = vm.readFile(OUT);
        Case[] memory cases = _cases();
        for (uint256 i; i < cases.length; ++i) {
            string memory base = string.concat(".vectors[", vm.toString(i), "].");
            assertEq(vm.parseJsonString(json, string.concat(base, "name")), cases[i].name, "vector order drifted");

            (bytes32 safeTxHash, bytes memory preimage,) = _derive(cases[i]);
            assertEq(
                vm.parseJsonBytes32(json, string.concat(base, "safeTxHash")),
                safeTxHash,
                string.concat("safeTxHash drifted for ", cases[i].name)
            );
            assertEq(
                vm.parseJsonBytes(json, string.concat(base, "preimage")),
                preimage,
                string.concat("preimage drifted for ", cases[i].name)
            );
            assertEq(
                vm.parseJsonAddress(json, string.concat(base, "safeAddress")),
                cases[i].safe,
                string.concat("safe address drifted for ", cases[i].name)
            );
            // The committed signature must still satisfy the committed digest.
            assertEq(
                p256Owner.isValidSignature(preimage, vm.parseJsonBytes(json, string.concat(base, "p256Signature"))),
                bytes4(0x20c13b0b),
                string.concat("committed signature no longer validates for ", cases[i].name)
            );
        }
    }

    function _generate() internal {
        Case[] memory cases = _cases();
        string[] memory entries = new string[](cases.length);
        for (uint256 i; i < cases.length; ++i) {
            entries[i] = _emit(cases[i]);
        }

        string memory root = "root";
        vm.serializeString(root, "source", "on-chain Safe v1.4.1 getTransactionHash, Monad testnet fork");
        vm.serializeAddress(root, "safeSingleton", SAFE_SINGLETON);
        vm.serializeAddress(root, "usdc", USDC);
        vm.serializeString(root, "safeVersion", ISafe(SAFE_SINGLETON).VERSION());
        string memory out = vm.serializeString(root, "vectors", entries);
        vm.writeJson(out, OUT);
    }

    /// @dev The Circle Safes are created with fixed salts and fixed owners, so CREATE2 puts them
    ///      at the same addresses on every run and the vectors stay reproducible.
    function _cases() internal returns (Case[] memory cases) {
        ISafe circleA = _safeAt(address(p256Owner), 1001);
        ISafe circleB = _safeAt(address(p256Owner), 1002);
        ISafe circleEoa = _safeAt(meraOwner, 1003);

        address tobi = makeAddr("tobi");
        address ada = makeAddr("ada");

        cases = new Case[](6);
        cases[0] = Case({
            name: "usdc_pay_tobi_20",
            safe: address(circleA),
            chainId: 10143,
            to: USDC,
            value: 0,
            data: abi.encodeCall(IERC20.transfer, (tobi, 20_000000)),
            operation: SafeOperation.Call,
            nonce: 0,
            humanRecipient: "Tobi",
            amountDisplay: "20.00"
        });
        cases[1] = Case({
            name: "usdc_pay_tobi_20_next_nonce",
            safe: address(circleA),
            chainId: 10143,
            to: USDC,
            value: 0,
            data: abi.encodeCall(IERC20.transfer, (tobi, 20_000000)),
            operation: SafeOperation.Call,
            nonce: 1,
            humanRecipient: "Tobi",
            amountDisplay: "20.00"
        });
        cases[2] = Case({
            name: "usdc_pay_ada_1234_56",
            safe: address(circleA),
            chainId: 10143,
            to: USDC,
            value: 0,
            data: abi.encodeCall(IERC20.transfer, (ada, 1234_560000)),
            operation: SafeOperation.Call,
            nonce: 0,
            humanRecipient: "Ada",
            amountDisplay: "1234.56"
        });
        cases[3] = Case({
            name: "same_payment_different_circle",
            safe: address(circleB),
            chainId: 10143,
            to: USDC,
            value: 0,
            data: abi.encodeCall(IERC20.transfer, (tobi, 20_000000)),
            operation: SafeOperation.Call,
            nonce: 0,
            humanRecipient: "Tobi",
            amountDisplay: "20.00"
        });
        cases[4] = Case({
            name: "same_payment_monad_mainnet_chainid",
            safe: address(circleA),
            chainId: 143,
            to: USDC,
            value: 0,
            data: abi.encodeCall(IERC20.transfer, (tobi, 20_000000)),
            operation: SafeOperation.Call,
            nonce: 0,
            humanRecipient: "Tobi",
            amountDisplay: "20.00"
        });
        cases[5] = Case({
            name: "eoa_owned_circle_zero_amount_edge",
            safe: address(circleEoa),
            chainId: 10143,
            to: USDC,
            value: 0,
            data: abi.encodeCall(IERC20.transfer, (tobi, 0)),
            operation: SafeOperation.Call,
            nonce: 0,
            humanRecipient: "Tobi",
            amountDisplay: "0.00"
        });

    }

    /// @dev The exact bytes handed to `execTransaction` for a single EIP-1271 contract owner.
    ///      Mirrors protocol-kit's `buildSignatureBytes`: a 65-byte static slot whose `s` field
    ///      points at the dynamic part, `v = 0` marking a contract signature, then length+data.
    function _envelope(address, address owner, bytes memory sig) internal pure returns (bytes memory) {
        return abi.encodePacked(
            bytes32(uint256(uint160(owner))), bytes32(uint256(65)), uint8(0), uint256(sig.length), sig
        );
    }

    /// @dev Asks the deployed Safe itself for the digest under the case's chainId, then signs it
    ///      with the Prism P-256 convention so the Swift suite has a full reference row.
    function _emit(Case memory c) internal returns (string memory) {
        (bytes32 safeTxHash, bytes memory preimage, bytes32 domain) = _derive(c);
        bytes memory sig = _signP256(0, safeTxHash);
        assertEq(
            p256Owner.isValidSignature(preimage, sig),
            bytes4(0x20c13b0b),
            "P-256 owner rejected its own signature over the vector"
        );

        string memory k = c.name;
        vm.serializeString(k, "name", c.name);
        vm.serializeAddress(k, "safeAddress", c.safe);
        vm.serializeUint(k, "chainId", c.chainId);
        vm.serializeAddress(k, "to", c.to);
        vm.serializeUint(k, "value", c.value);
        vm.serializeBytes(k, "data", c.data);
        vm.serializeUint(k, "operation", uint256(c.operation));
        vm.serializeUint(k, "safeTxGas", 0);
        vm.serializeUint(k, "baseGas", 0);
        vm.serializeUint(k, "gasPrice", 0);
        vm.serializeAddress(k, "gasToken", address(0));
        vm.serializeAddress(k, "refundReceiver", address(0));
        vm.serializeUint(k, "nonce", c.nonce);
        vm.serializeString(k, "humanRecipient", c.humanRecipient);
        vm.serializeString(k, "amountDisplay", c.amountDisplay);
        vm.serializeBytes32(k, "domainSeparator", domain);
        vm.serializeBytes(k, "preimage", preimage);
        vm.serializeBytes(k, "p256Signature", sig);
        vm.serializeBytes(k, "contractSignatureEnvelope", _envelope(c.safe, address(p256Owner), sig));
        return vm.serializeBytes32(k, "safeTxHash", safeTxHash);
    }
}
