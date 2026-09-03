// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccount} from "./interfaces/IAccount.sol";
import {PackedUserOperation} from "./interfaces/PackedUserOperation.sol";
import {P256Verifier} from "./libraries/P256Verifier.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";
import {IPrismClaimVault} from "./interfaces/IPrismClaimVault.sol";

/// @title PrismAccount
/// @notice Minimal ERC-4337 account whose spending authority is an iPhone P-256 key.
/// @dev Prism signs the 32-byte ERC-4337 userOpHash using CryptoKit's data-signing API.
///      CryptoKit applies SHA-256 to those bytes before P-256 ECDSA, therefore this
///      account verifies SHA256(userOpHash) at Monad's native EIP-7951 precompile.
contract PrismAccount is IAccount {
    using SafeTransferLib for address;
    error NotEntryPoint();
    error NotSelf();
    error InvalidPublicKey();
    error InvalidSignatureEncoding();
    error ExecutionFailed(uint256 index, bytes returndata);

    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    bytes4 internal constant ERC1271_MAGICVALUE = 0x1626ba7e;

    address public immutable entryPoint;
    uint256 public qx;
    uint256 public qy;

    event P256KeyRotated(uint256 indexed oldQx, uint256 indexed newQx, uint256 newQy);
    event Executed(address indexed target, uint256 value, bytes data);
    event PaymentExecuted(bytes32 indexed paymentRef, address indexed token, address indexed recipient, uint256 amount);
    event ClaimFunded(bytes32 indexed claimId, address indexed vault, uint256 amount);
    event ClaimCollected(bytes32 indexed claimId, address indexed vault);
    event ClaimRefundRequested(bytes32 indexed claimId, address indexed vault);

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    constructor(address entryPoint_, uint256 qx_, uint256 qy_) payable {
        if (entryPoint_ == address(0)) revert NotEntryPoint();
        if (!P256Verifier.isValidPublicKey(qx_, qy_)) revert InvalidPublicKey();
        entryPoint = entryPoint_;
        qx = qx_;
        qy = qy_;
    }

    receive() external payable {}

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external override onlyEntryPoint returns (uint256 validationData) {
        if (userOp.sender != address(this)) return SIG_VALIDATION_FAILED;
        if (userOp.signature.length != 64) return SIG_VALIDATION_FAILED;

        uint256 r;
        uint256 s;
        assembly {
            r := calldataload(userOp.signature.offset)
            s := calldataload(add(userOp.signature.offset, 32))
        }

        bytes32 p256Digest = sha256(abi.encodePacked(userOpHash));
        if (!P256Verifier.verify(p256Digest, r, s, qx, qy)) {
            return SIG_VALIDATION_FAILED;
        }

        // Normally zero when a paymaster sponsors gas. Kept for ERC-4337 compatibility.
        if (missingAccountFunds != 0) {
            (bool sent,) = payable(entryPoint).call{value: missingAccountFunds}("");
            sent; // EntryPoint handles lack of prefund during validation.
        }

        return 0;
    }

    function execute(address target, uint256 value, bytes calldata data) external onlyEntryPoint {
        (bool ok, bytes memory returndata) = target.call{value: value}(data);
        if (!ok) revert ExecutionFailed(0, returndata);
        emit Executed(target, value, data);
    }

    function executeBatch(Call[] calldata calls) external onlyEntryPoint {
        uint256 length = calls.length;
        for (uint256 i; i < length; ++i) {
            Call calldata c = calls[i];
            (bool ok, bytes memory returndata) = c.target.call{value: c.value}(c.data);
            if (!ok) revert ExecutionFailed(i, returndata);
            emit Executed(c.target, c.value, c.data);
        }
    }

    /// @notice First-class stablecoin payment path. `paymentRef` is opaque and may be
    ///         a requestId or random payment identifier; never a phone-derived value.
    /// @dev Including the reference in calldata binds it to the signed UserOperation.
    function executeTokenPayment(
        address token,
        address recipient,
        uint256 amount,
        bytes32 paymentRef
    ) external onlyEntryPoint {
        token.safeTransfer(recipient, amount);
        emit PaymentExecuted(paymentRef, token, recipient, amount);
    }

    function createTokenClaim(
        address vault,
        bytes32 claimId,
        bytes32 recipientReference,
        address token,
        uint256 amount,
        uint64 expiry
    ) external onlyEntryPoint {
        token.safeApprove(vault, 0);
        token.safeApprove(vault, amount);
        IPrismClaimVault(vault).createClaim(claimId, recipientReference, token, amount, expiry);
        emit ClaimFunded(claimId, vault, amount);
    }

    function collectClaim(
        address vault,
        bytes32 claimId,
        uint64 aliasVersion,
        uint256 nonce,
        uint64 deadline,
        bytes calldata authorization
    ) external onlyEntryPoint {
        IPrismClaimVault(vault).claim(claimId, address(this), aliasVersion, nonce, deadline, authorization);
        emit ClaimCollected(claimId, vault);
    }

    function refundClaim(address vault, bytes32 claimId) external onlyEntryPoint {
        IPrismClaimVault(vault).refund(claimId);
        emit ClaimRefundRequested(claimId, vault);
    }

    /// @notice Key rotation is only reachable by a UserOperation that makes the account call itself.
    function rotateP256Key(uint256 newQx, uint256 newQy) external onlySelf {
        if (!P256Verifier.isValidPublicKey(newQx, newQy)) revert InvalidPublicKey();
        uint256 oldQx = qx;
        qx = newQx;
        qy = newQy;
        emit P256KeyRotated(oldQx, newQx, newQy);
    }

    /// @notice EIP-1271 compatibility for Prism-specific P-256 signatures.
    /// @dev `hash` is SHA-256'd for parity with Secure Enclave `signature(for: Data)`.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 64) return 0xffffffff;
        uint256 r;
        uint256 s;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
        }
        bytes32 digest = sha256(abi.encodePacked(hash));
        return P256Verifier.verify(digest, r, s, qx, qy) ? ERC1271_MAGICVALUE : bytes4(0xffffffff);
    }
}
