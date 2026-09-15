// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {P256Verifier} from "prism-archive/libraries/P256Verifier.sol";

/// @title PrismP256SafeOwner
/// @notice An EIP-1271 contract owner that lets a Prism P-256 authority (an iPhone Secure Enclave
///         key) be an owner of a Circle's Safe without ever holding a second credential.
///
/// @dev WHY THIS EXISTS, PRECISELY.
///
///      Safe v1.4.1 validates a contract owner through the *legacy* EIP-1271 entrypoint:
///
///          Safe.checkNSignatures:
///            require(keccak256(data) == dataHash, "GS027");
///            require(ISignatureValidator(owner).isValidSignature(data, sig) == 0x20c13b0b, "GS024");
///
///      It calls `isValidSignature(bytes,bytes)` and demands the magic value `0x20c13b0b`.
///      It does NOT call `isValidSignature(bytes32,bytes)` / `0x1626ba7e`.
///
///      `archive/erc4337-p256/src/PrismAccount.sol` implements only the `bytes32` form, so a Safe
///      v1.4.1 can never validate it as an owner — the call hits no matching function. This
///      contract supplies the surface Safe actually calls, over the identical P-256 key material
///      and the identical digest convention, so no new user credential is introduced.
///
///      DIGEST CONVENTION. Prism iOS signs with CryptoKit's `signature(for: Data)`, which applies
///      SHA-256 to the message before P-256 ECDSA. The phone is handed the 32-byte Safe
///      transaction hash, so the value actually signed is SHA256(safeTxHash). Both entrypoints
///      below therefore verify SHA256(hash) at Monad's EIP-7951 precompile, matching
///      `PrismAccount.isValidSignature`'s `sha256(abi.encodePacked(hash))` byte for byte.
///
///      BINDING. No Safe address is stored here on purpose. `safeTxHash` is an EIP-712 digest over
///      a domain whose `verifyingContract` is the Safe and whose `chainId` is the chain, so a
///      signature minted for one Circle's Safe cannot validate a transaction on another Safe,
///      another chain, or another nonce. Binding is carried by the hash, not by local state.
///
///      MALLEABILITY. Monad's EIP-7951 precompile accepts both `s` and `n - s`; it does not
///      enforce low-s. A Safe transaction is replay-protected by its nonce, so the malleable twin
///      cannot re-execute anything. Off-chain code must not treat signature bytes as a unique
///      proposal identifier — key proposals by `safeTxHash`.
contract PrismP256SafeOwner {
    /// @dev bytes4(keccak256("isValidSignature(bytes,bytes)")) — the value Safe v1.4.1 requires.
    bytes4 internal constant LEGACY_MAGIC_VALUE = 0x20c13b0b;
    /// @dev bytes4(keccak256("isValidSignature(bytes32,bytes)")) — EIP-1271 as finalised.
    bytes4 internal constant UPDATED_MAGIC_VALUE = 0x1626ba7e;
    /// @dev Parity with `PrismAccount`, which returns this rather than `0x00000000` on failure.
    bytes4 internal constant INVALID = 0xffffffff;

    error InvalidPublicKey();

    /// @notice Affine coordinates of the Prism P-256 authority that owns this Circle seat.
    uint256 public immutable qx;
    uint256 public immutable qy;

    constructor(uint256 qx_, uint256 qy_) {
        if (!P256Verifier.isValidPublicKey(qx_, qy_)) revert InvalidPublicKey();
        qx = qx_;
        qy = qy_;
    }

    /// @notice Legacy EIP-1271 entrypoint. This is the one Safe v1.4.1 actually calls.
    /// @param data The EIP-712 pre-image of the Safe transaction. Safe has already asserted
    ///             `keccak256(data) == safeTxHash`, so hashing it here recovers the signed digest.
    function isValidSignature(bytes memory data, bytes memory signature) public view returns (bytes4) {
        return _verify(keccak256(data), signature) ? LEGACY_MAGIC_VALUE : INVALID;
    }

    /// @notice Modern EIP-1271 entrypoint, for callers that pass the digest directly.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _verify(hash, signature) ? UPDATED_MAGIC_VALUE : INVALID;
    }

    /// @dev A Prism signature is exactly the 64-byte raw `r || s`; anything else is rejected
    ///      outright rather than being coerced into a shorter or longer read.
    function _verify(bytes32 hash, bytes memory signature) internal view returns (bool) {
        if (signature.length != 64) return false;
        uint256 r;
        uint256 s;
        assembly {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
        }
        return P256Verifier.verify(sha256(abi.encodePacked(hash)), r, s, qx, qy);
    }
}
