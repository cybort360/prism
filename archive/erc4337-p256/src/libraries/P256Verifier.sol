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

    function verify(
        bytes32 digest,
        uint256 r,
        uint256 s,
        uint256 qx,
        uint256 qy
    ) internal view returns (bool ok) {
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
