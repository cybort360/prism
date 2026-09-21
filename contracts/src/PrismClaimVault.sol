// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC3009} from "./interfaces/IERC3009.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";
import {PrismEIP712} from "./libraries/PrismEIP712.sol";

/// @title PrismClaimVault
/// @notice Escrow for USDC sent to someone who has not joined Prism yet.
/// @dev Funded gaslessly via ERC-3009 `receiveWithAuthorization` (sender needs zero MON).
///      Collection requires BOTH an isolated backend "claim authorizer" EIP-712 signature (bind
///      claimId/recipient/aliasVersion/expiry/nonce) AND the recipient's own Mera-account EIP-712
///      `ClaimIntent`. A relayer submits and pays gas. After expiry, funds always return to the
///      original sender and the refund is permissionless. No phone number or phone-derived value
///      ever appears in state or events; `claimId` and `recipientReference` are random.
contract PrismClaimVault {
    using SafeTransferLib for address;

    enum ClaimStatus {
        None,
        Funded,
        Claimed,
        Refunded
    }

    struct Claim {
        bytes32 claimId;
        bytes32 recipientReference;
        address sender;
        uint256 amount;
        uint256 expiry;
        ClaimStatus status;
    }

    IERC3009 public immutable usdc;
    bytes32 public immutable domainSeparator;

    /// @notice secp256k1 address of the isolated eligibility signer. Production: KMS/HSM. Never a
    ///         hardcoded key — set at deploy from config and rotatable by the owner.
    address public claimAuthorizer;
    address public owner;
    address public pendingOwner;

    bytes32 public constant CLAIM_ELIGIBILITY_TYPEHASH = keccak256(
        "ClaimEligibility(bytes32 claimId,address recipient,uint256 aliasVersion,uint256 expiry,bytes32 nonce)"
    );
    bytes32 public constant CLAIM_INTENT_TYPEHASH = keccak256("ClaimIntent(bytes32 claimId,address recipient)");

    mapping(bytes32 => Claim) public claims;
    // Per-claim eligibility nonce namespace ([claimId][nonce]): a transition on one claim can never
    // invalidate a sibling claim's authorization, even if an authorizer reissues a nonce (C-01).
    mapping(bytes32 => mapping(bytes32 => bool)) public eligibilityNonceUsed;

    event ClaimFunded(
        bytes32 indexed claimId, address indexed sender, uint256 amount, uint256 expiry, bytes32 recipientReference
    );
    event ClaimCollected(bytes32 indexed claimId, address indexed recipient, uint256 amount);
    event ClaimRefunded(bytes32 indexed claimId, address indexed sender, uint256 amount);
    event ClaimAuthorizerUpdated(address indexed previous, address indexed current);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error ZeroAddress();
    error InvalidClaim();
    error ClaimExists();
    error NotFunded();
    error ClaimIsExpired();
    error NotYetExpired();
    error EligibilityExpired();
    error EligibilityReused();
    error BadEligibility();
    error BadRecipientIntent();
    error NonceBindingMismatch();
    error NotOwner();
    error NotPendingOwner();

    constructor(address owner_, address usdc_, address claimAuthorizer_) {
        if (owner_ == address(0) || usdc_ == address(0) || claimAuthorizer_ == address(0)) revert ZeroAddress();
        owner = owner_;
        usdc = IERC3009(usdc_);
        claimAuthorizer = claimAuthorizer_;
        domainSeparator = PrismEIP712.domainSeparator("PrismClaimVault", "1", address(this));
        emit OwnershipTransferred(address(0), owner_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Fund a claim by pulling USDC via ERC-3009.
    /// @dev The nonce binds the claim, amount, sender, and expiry so a relayer cannot repoint it
    ///      to a different expiry or recipient reference.
    function fundClaim(
        bytes32 claimId,
        bytes32 recipientReference,
        address sender,
        uint256 amount,
        uint256 expiry,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (claimId == bytes32(0) || recipientReference == bytes32(0) || sender == address(0) || amount == 0) {
            revert InvalidClaim();
        }
        if (expiry <= block.timestamp) revert InvalidClaim();
        if (claims[claimId].status != ClaimStatus.None) revert ClaimExists();
        if (nonce != fundingNonce(claimId, recipientReference, amount, sender, expiry)) revert NonceBindingMismatch();

        claims[claimId] = Claim({
            claimId: claimId,
            recipientReference: recipientReference,
            sender: sender,
            amount: amount,
            expiry: expiry,
            status: ClaimStatus.Funded
        });

        // receiveWithAuthorization requires `to == msg.sender`, so only this vault can pull the funds,
        // atomically with recording the claim. No orphaned deposits.
        usdc.receiveWithAuthorization(sender, address(this), amount, validAfter, validBefore, nonce, v, r, s);
        emit ClaimFunded(claimId, sender, amount, expiry, recipientReference);
    }

    /// @notice Collect a funded claim. Requires BOTH the backend eligibility authorization and the
    ///         recipient's own Mera-account intent.
    function claim(
        bytes32 claimId,
        address recipient,
        uint256 aliasVersion,
        uint256 eligibilityExpiry,
        bytes32 eligibilityNonce,
        bytes calldata authorizerSig,
        bytes calldata recipientSig
    ) external {
        Claim storage c = claims[claimId];
        if (c.status != ClaimStatus.Funded) revert NotFunded();
        if (block.timestamp > c.expiry) revert ClaimIsExpired();
        if (recipient == address(0)) revert BadRecipientIntent();
        if (block.timestamp > eligibilityExpiry) revert EligibilityExpired();
        if (eligibilityNonceUsed[claimId][eligibilityNonce]) revert EligibilityReused();

        // (1) Backend eligibility: an isolated authorizer key vouches that `recipient` controls the alias.
        bytes32 eligStruct = keccak256(
            abi.encode(
                CLAIM_ELIGIBILITY_TYPEHASH, claimId, recipient, aliasVersion, eligibilityExpiry, eligibilityNonce
            )
        );
        address authorizer = PrismEIP712.recover(PrismEIP712.digest(domainSeparator, eligStruct), authorizerSig);
        if (authorizer == address(0) || authorizer != claimAuthorizer) revert BadEligibility();

        // (2) Recipient authorization: the recipient's Mera account signs its intent to claim.
        bytes32 intentStruct = keccak256(abi.encode(CLAIM_INTENT_TYPEHASH, claimId, recipient));
        address intentSigner = PrismEIP712.recover(PrismEIP712.digest(domainSeparator, intentStruct), recipientSig);
        if (intentSigner == address(0) || intentSigner != recipient) revert BadRecipientIntent();

        eligibilityNonceUsed[claimId][eligibilityNonce] = true;
        c.status = ClaimStatus.Claimed;
        address(usdc).safeTransfer(recipient, c.amount);
        emit ClaimCollected(claimId, recipient, c.amount);
    }

    /// @notice After expiry, return a funded claim to its original sender. Permissionless — funds can
    ///         only ever go to `c.sender`, so the caller can never redirect them.
    function refund(bytes32 claimId) external {
        Claim storage c = claims[claimId];
        if (c.status != ClaimStatus.Funded) revert NotFunded();
        if (block.timestamp <= c.expiry) revert NotYetExpired();

        c.status = ClaimStatus.Refunded;
        address(usdc).safeTransfer(c.sender, c.amount);
        emit ClaimRefunded(claimId, c.sender, c.amount);
    }

    function fundingNonce(bytes32 claimId, bytes32 recipientReference, uint256 amount, address sender, uint256 expiry)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(claimId, recipientReference, amount, sender, expiry));
    }

    function eligibilityDigest(bytes32 claimId, address recipient, uint256 aliasVersion, uint256 expiry, bytes32 nonce)
        external
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(CLAIM_ELIGIBILITY_TYPEHASH, claimId, recipient, aliasVersion, expiry, nonce));
        return PrismEIP712.digest(domainSeparator, structHash);
    }

    function claimIntentDigest(bytes32 claimId, address recipient) external view returns (bytes32) {
        return PrismEIP712.digest(domainSeparator, keccak256(abi.encode(CLAIM_INTENT_TYPEHASH, claimId, recipient)));
    }

    function setClaimAuthorizer(address newAuthorizer) external onlyOwner {
        if (newAuthorizer == address(0)) revert ZeroAddress();
        emit ClaimAuthorizerUpdated(claimAuthorizer, newAuthorizer);
        claimAuthorizer = newAuthorizer;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}
