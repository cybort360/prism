// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice ERC-20 functions plus the ERC-3009 authorization methods Prism needs.
interface IERC3009 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);

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

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
