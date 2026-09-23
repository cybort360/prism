// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MockVault} from "../src/mocks/MockVault.sol";

/// Deploys the demo Save vault over an existing MockUSDC. Set USDC_ADDRESS to the testnet MockUSDC.
contract DeployMockVault is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        MockVault vault = new MockVault(usdc);
        vm.stopBroadcast();
        console2.log("MockVault deployed at:", address(vault));
        console2.log("Set SAVE_MOCK_VAULT to the address above.");
    }
}
