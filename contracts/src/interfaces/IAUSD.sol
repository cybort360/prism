// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IAUSD
/// @notice The subset of Agora AUSD that Prism relies on: ERC-20 plus the ERC-3009
///         authorization family. Prism uses the canonical `(v, r, s)` signature variant, which a
///         Mera passkey-derived secp256k1 account produces directly.
/// @dev Live AUSD (verify against https://docs.agora.finance): Monad mainnet
///      0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a (chainId 143), Monad testnet
///      0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC (chainId 10143). Domain: name "Agora Dollar",
///      version "1", 6 decimals.
interface IAUSD {
    // --- ERC-20 ---
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);

    // --- ERC-3009 ---
    /// @notice Move `value` from `from` to `to` under an off-chain authorization signed by `from`.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice Like `transferWithAuthorization` but requires `to == msg.sender` (front-run safe pull).
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
