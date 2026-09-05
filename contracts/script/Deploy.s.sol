// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {PrismPaymentRouter} from "../src/PrismPaymentRouter.sol";
import {PrismClaimVault} from "../src/PrismClaimVault.sol";

/// @notice Deploys Prism's payment surface against Circle USDC.
/// @dev Verify USDC against https://developers.circle.com/stablecoins/usdc-contract-addresses.
///      Run: forge script script/Deploy.s.sol --rpc-url $MONAD_TESTNET_RPC_URL --broadcast
contract Deploy is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address usdc = vm.envAddress("USDC_ADDRESS");
        // Ordinary secp256k1 address of the isolated claim authorizer (KMS/HSM in production).
        address claimAuthorizer = vm.envAddress("CLAIM_AUTHORIZER_ADDRESS");
        address deployer = vm.addr(key);

        vm.startBroadcast(key);
        PrismPaymentRouter router = new PrismPaymentRouter(usdc);
        PrismClaimVault vault = new PrismClaimVault(deployer, usdc, claimAuthorizer);
        vm.stopBroadcast();

        console2.log("USDC", usdc);
        console2.log("PrismPaymentRouter", address(router));
        console2.log("PrismClaimVault", address(vault));

        _writeManifest(usdc, address(router), address(vault), claimAuthorizer, deployer);
    }

    /// @dev Emits deployments/monad-<chainid>.json. Addresses are written here, NEVER into Swift.
    function _writeManifest(address usdc, address router, address vault, address authorizer, address deployer)
        internal
    {
        string memory network = block.chainid == 143 ? "mainnet" : "testnet";
        string memory obj = "manifest";
        vm.serializeString(obj, "network", string.concat("monad-", network));
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "deployedAt", block.timestamp);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "usdc", usdc);
        vm.serializeAddress(obj, "paymentRouter", router);
        vm.serializeAddress(obj, "claimAuthorizer", authorizer);
        string memory json = vm.serializeAddress(obj, "claimVault", vault);

        // Addresses land in a manifest — never in Swift source.
        string memory path = string.concat("../deployments/monad-", network, ".json");
        vm.writeJson(json, path);
        console2.log("manifest written", path);
    }
}
