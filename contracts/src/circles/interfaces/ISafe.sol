// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Operation type accepted by Safe. Prism Circles only ever uses `Call`.
enum SafeOperation {
    Call,
    DelegateCall
}

/// @notice The subset of the Safe v1.4.1 singleton surface Prism Circles depends on.
/// @dev Deliberately narrow: Circles never touches modules, guards, or owner management through
///      this interface. Verified deployment addresses live in `docs/CIRCLES_DEPENDENCY_AUDIT.md`.
interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        SafeOperation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        SafeOperation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);

    function encodeTransactionData(
        address to,
        uint256 value,
        bytes calldata data,
        SafeOperation operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes memory);

    function nonce() external view returns (uint256);
    function domainSeparator() external view returns (bytes32);
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function isOwner(address owner) external view returns (bool);
    function VERSION() external view returns (string memory);
}

/// @notice Safe v1.4.1 proxy factory surface used to create a Circle's Safe.
interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);

    function proxyCreationCode() external pure returns (bytes memory);
}
