// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockAUSD} from "./MockAUSD.sol";

/// @notice Test token matching Circle USDC's Monad ERC-3009 EIP-712 domain.
contract MockUSDC is MockAUSD {
    constructor() {
        name = "USDC";
        symbol = "USDC";
        version = "2";
    }
}
