// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PrismEIP712
/// @notice Minimal EIP-712 domain hashing and EIP-2 safe ECDSA recovery for Prism's envelope and
///         eligibility signatures. No external dependency; audited-shape and self-contained.
library PrismEIP712 {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @notice EIP-712 domain separator for a Prism contract.
    function domainSeparator(string memory name, string memory version, address verifyingContract)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, verifyingContract)
        );
    }

    /// @notice EIP-712 typed-data digest: keccak256("\x19\x01" || domainSeparator || structHash).
    function digest(bytes32 domainSep, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    /// @notice Recover a signer from a 65-byte `r||s||v` signature, rejecting malleable high-s.
    /// @dev Returns address(0) on any malformed/invalid input so callers can fail closed.
    function recover(bytes32 hash, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        return recover(hash, v, r, s);
    }

    function recover(bytes32 hash, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
        // Reject the upper half of the curve order (EIP-2) to prevent signature malleability.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(hash, v, r, s);
    }
}
