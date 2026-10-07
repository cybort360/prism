// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Monad EIP-7951 P256VERIFY helper.
/// @dev The precompile at 0x0100 accepts exactly:
///      hash || r || s || qx || qy, all 32-byte big-endian values.
library P256Verifier {
    address internal constant PRECOMPILE = address(0x0100);

    uint256 internal constant FIELD_P =
        0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff;
    uint256 internal constant CURVE_B =
        0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b;
    /// @dev Order n of the P-256 base point. Valid signature scalars satisfy r, s ∈ [1, n-1].
    uint256 internal constant CURVE_N =
        0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;

    function verify(
        bytes32 digest,
        uint256 r,
        uint256 s,
        uint256 qx,
        uint256 qy
    ) internal view returns (bool ok) {
        // Explicit scalar-range guard (audit P1.5): the EIP-7951 precompile is specified to reject
        // out-of-range scalars, but checking r, s ∈ [1, n-1] here makes that a property of this
        // library rather than a trusted dependency, and fails closed on a non-conforming precompile.
        // NOTE: we deliberately do NOT enforce low-s (s <= n/2). WebAuthn / CryptoKit P-256 signatures
        // are not low-s normalized, so rejecting high-s would reject legitimate device signatures;
        // signature malleability is already non-exploitable because every nonce is single-use.
        if (r == 0 || r >= CURVE_N || s == 0 || s >= CURVE_N) return false;
        bytes memory input = abi.encodePacked(digest, r, s, qx, qy);
        (bool success, bytes memory output) = PRECOMPILE.staticcall(input);
        return success && output.length == 32 && abi.decode(output, (uint256)) == 1;
    }

    /// @dev Cheap deployment guard so obviously invalid keys cannot brick an account.
    ///      Checks field bounds and the P-256 curve equation y² = x³ - 3x + b (mod p).
    function isValidPublicKey(uint256 qx, uint256 qy) internal pure returns (bool) {
        if (qx == 0 || qy == 0 || qx >= FIELD_P || qy >= FIELD_P) return false;
        uint256 y2 = mulmod(qy, qy, FIELD_P);
        uint256 x2 = mulmod(qx, qx, FIELD_P);
        uint256 x3 = mulmod(x2, qx, FIELD_P);
        uint256 threeX = mulmod(3, qx, FIELD_P);
        uint256 rhs = addmod(addmod(x3, FIELD_P - threeX, FIELD_P), CURVE_B, FIELD_P);
        return y2 == rhs;
    }
}
