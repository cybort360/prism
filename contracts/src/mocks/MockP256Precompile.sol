// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Local test double etched at 0x0100. Returns the EIP-7951 "valid" word (1) iff the 32-byte
///      digest — the first word of the 160-byte `digest||r||s||qx||qy` input — equals the configured
///      expectedDigest. This lets tests prove the account BINDS the digest (mutating amount/recipient/
///      nonce/expiry changes the digest → the precompile returns empty → the account reverts) without
///      re-implementing P-256 curve math locally. The real precompile is exercised live on Monad.
contract MockP256Precompile {
    bytes32 internal immutable expectedDigest;

    constructor(bytes32 expectedDigest_) {
        expectedDigest = expectedDigest_;
    }

    fallback() external {
        if (msg.data.length != 160) {
            assembly { return(0, 0) }
        }
        bytes32 d;
        assembly { d := calldataload(0) }
        if (d != expectedDigest) {
            assembly { return(0, 0) }
        }
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}
