// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PrismPaymentRouter} from "../src/PrismPaymentRouter.sol";
import {PrismClaimVault} from "../src/PrismClaimVault.sol";

/// @notice Deploys Prism's on-chain payment surface against a live AUSD token and writes a
///         deployment manifest. AUSD itself is deployed by Agora; Prism only deploys the router and
///         the claim vault.
/// @dev Verify AUSD against https://docs.agora.finance:
///      Monad mainnet 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a (chainId 143),
///      Monad testnet 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC (chainId 10143).
///      Run: forge script script/Deploy.s.sol --rpc-url $MONAD_TESTNET_RPC_URL --broadcast
contract Deploy is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address ausd = vm.envAddress("AUSD_ADDRESS");
        // Ordinary secp256k1 address of the isolated claim authorizer (KMS/HSM in production).
        address claimAuthorizer = vm.envAddress("CLAIM_AUTHORIZER_ADDRESS");
        address deployer = vm.addr(key);

        vm.startBroadcast(key);
        PrismPaymentRouter router = new PrismPaymentRouter(ausd);
        PrismClaimVault vault = new PrismClaimVault(deployer, ausd, claimAuthorizer);
        vm.stopBroadcast();

        console2.log("AUSD", ausd);
        console2.log("PrismPaymentRouter", address(router));
        console2.log("PrismClaimVault", address(vault));

        _writeManifest(ausd, address(router), address(vault), claimAuthorizer, deployer);
    }

    /// @dev Emits deployments/monad-<chainid>.json. Addresses are written here, NEVER into Swift.
    function _writeManifest(address ausd, address router, address vault, address authorizer, address deployer)
        internal
    {
        string memory network = block.chainid == 143 ? "mainnet" : "testnet";
        string memory obj = "manifest";
        vm.serializeString(obj, "network", string.concat("monad-", network));
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "deployedAt", block.timestamp);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "ausd", ausd);
        vm.serializeAddress(obj, "paymentRouter", router);
        vm.serializeAddress(obj, "claimAuthorizer", authorizer);
        string memory json = vm.serializeAddress(obj, "claimVault", vault);

        // Addresses land in a manifest — never in Swift source.
        string memory path = string.concat("../deployments/monad-", network, ".json");
        vm.writeJson(json, path);
        console2.log("manifest written", path);
    }
}
