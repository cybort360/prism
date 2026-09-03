// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Test helper etched at address(0x0100). It mimics EIP-7951 raw return data:
///      32-byte word 1 for the configured r value, empty output otherwise.
contract MockP256Precompile {
    uint256 immutable expectedR;
    constructor(uint256 expectedR_) { expectedR = expectedR_; }

    fallback() external {
        if (msg.data.length != 160) { assembly { return(0, 0) } }
        uint256 r;
        assembly { r := calldataload(32) }
        if (r != expectedR) { assembly { return(0, 0) } }
        assembly { mstore(0, 1) return(0, 32) }
    }
}
