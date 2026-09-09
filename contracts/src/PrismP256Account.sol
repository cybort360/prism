// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {P256Verifier} from "./libraries/P256Verifier.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title PrismP256Account
/// @notice A Prism smart account whose spending authority is a device-backed **P-256 (secp256r1 /
///         WebAuthn passkey)** key, verified **on-chain** via Monad's EIP-7951 / RIP-7212 precompile
///         (0x0100). The account holds USDC. A relayer (anyone) submits a payment authorized by a P-256
///         signature over the exact intent and pays the gas, so the account owner needs no MON — the
///         same gasless posture as the rest of Prism, with no bundler/EntryPoint dependency.
/// @dev    The device signs the `intent` bytes; ECDSA-P256 applies SHA-256 first (WebAuthn/CryptoKit),
///         so the account verifies `sha256(intent)` at the precompile. The signature binds the account,
///         chainId, token, recipient, amount, nonce and expiry — so mutating any field, or replaying a
///         nonce, changes/blocks the digest and fails on-chain.
contract PrismP256Account {
    using SafeTransferLib for address;

    /// @notice The device P-256 public key (uncompressed point coordinates) = the spending authority.
    uint256 public immutable qx;
    uint256 public immutable qy;

    /// @notice Single-use nonces — replay protection.
    mapping(bytes32 => bool) public usedNonce;

    error InvalidPublicKey();
    error Expired();
    error NonceAlreadyUsed();
    error BadP256Signature();

    event PaymentExecuted(bytes32 indexed nonce, address indexed token, address indexed recipient, uint256 amount);

    constructor(uint256 qx_, uint256 qy_) {
        if (!P256Verifier.isValidPublicKey(qx_, qy_)) revert InvalidPublicKey();
        qx = qx_;
        qy = qy_;
    }

    /// @notice The exact bytes the device P-256 key signs. Bound to this account and chain so a
    ///         signature cannot be replayed on another account or network.
    function intent(address token, address recipient, uint256 amount, bytes32 nonce, uint256 validBefore)
        public
        view
        returns (bytes memory)
    {
        return abi.encode(block.chainid, address(this), token, recipient, amount, nonce, validBefore);
    }

    /// @notice The 32-byte digest verified on-chain (SHA-256 of the intent, matching WebAuthn/CryptoKit).
    function digest(address token, address recipient, uint256 amount, bytes32 nonce, uint256 validBefore)
        public
        view
        returns (bytes32)
    {
        return sha256(intent(token, recipient, amount, nonce, validBefore));
    }

    /// @notice Execute a USDC payment authorized by a device P-256 signature. Callable by anyone (a
    ///         relayer), who pays the gas; the account owner spends no MON.
    /// @param r,s The P-256 signature (low-s) over `digest(...)` produced by the device key.
    function pay(
        address token,
        address recipient,
        uint256 amount,
        bytes32 nonce,
        uint256 validBefore,
        uint256 r,
        uint256 s
    ) external {
        if (block.timestamp > validBefore) revert Expired();
        if (usedNonce[nonce]) revert NonceAlreadyUsed();
        if (!P256Verifier.verify(digest(token, recipient, amount, nonce, validBefore), r, s, qx, qy)) {
            revert BadP256Signature();
        }
        usedNonce[nonce] = true; // effects before interaction (no reentrancy on a single transfer)
        token.safeTransfer(recipient, amount);
        emit PaymentExecuted(nonce, token, recipient, amount);
    }
}
