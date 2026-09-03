// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAUSD} from "./interfaces/IAUSD.sol";
import {PrismEIP712} from "./libraries/PrismEIP712.sol";

/// @title PrismPaymentRouter
/// @notice Gasless AUSD direct-payment settlement. The payer's Mera passkey-derived account signs
///         two things: (1) a Prism EIP-712 `PaymentEnvelope` binding Prism metadata (paymentId,
///         recipient, amount, requestId, resolutionHash, validity, nonce) and (2) the AUSD ERC-3009
///         `TransferWithAuthorization`. A relayer submits and pays MON, so the payer can hold
///         AUSD > 0 and MON = 0.
/// @dev The router cross-binds the two signatures: the AUSD authorization it submits is built from
///      the envelope fields (recipient = envelope.recipient, value = envelope.amount, nonce =
///      envelope.nonce), so a relayer that rewrites the recipient, amount, or reference invalidates
///      both the envelope signature and AUSD's own `ecrecover`. requestId / resolutionHash are
///      opaque Prism identifiers and are NEVER phone-derived.
contract PrismPaymentRouter {
    IAUSD public immutable ausd;
    bytes32 public immutable domainSeparator;

    bytes32 public constant PAYMENT_ENVELOPE_TYPEHASH = keccak256(
        "PaymentEnvelope(bytes32 paymentId,address payer,address recipient,address token,uint256 amount,bytes32 requestId,bytes32 resolutionHash,uint256 validBefore,bytes32 nonce)"
    );

    struct PaymentEnvelope {
        bytes32 paymentId;
        address payer;
        address recipient;
        address token;
        uint256 amount;
        bytes32 requestId;
        bytes32 resolutionHash;
        uint256 validBefore;
        bytes32 nonce;
    }

    mapping(bytes32 => bool) public paymentUsed;
    mapping(address => mapping(bytes32 => bool)) public nonceUsed;

    event PaymentSettled(
        bytes32 indexed paymentId,
        address indexed payer,
        address indexed recipient,
        uint256 amount,
        bytes32 requestId,
        bytes32 resolutionHash
    );

    error ZeroAddress();
    error ZeroAmount();
    error WrongToken();
    error Expired();
    error PaymentAlreadyUsed();
    error NonceAlreadyUsed();
    error BadEnvelopeSignature();

    constructor(address ausd_) {
        if (ausd_ == address(0)) revert ZeroAddress();
        ausd = IAUSD(ausd_);
        domainSeparator = PrismEIP712.domainSeparator("PrismPaymentRouter", "1", address(this));
    }

    /// @notice Settle a gasless AUSD payment described by a Prism `PaymentEnvelope`.
    /// @param env The Prism envelope, signed by `env.payer`'s Mera account (`prismSignature`).
    /// @param prismSignature secp256k1 signature over the EIP-712 envelope digest.
    /// @param v,r,s The payer's AUSD ERC-3009 `TransferWithAuthorization` signature. Its authorized
    ///        `to`/`value`/`nonce` are taken from the envelope, so the two signatures cannot disagree.
    function settle(PaymentEnvelope calldata env, bytes calldata prismSignature, uint8 v, bytes32 r, bytes32 s)
        external
    {
        if (env.payer == address(0) || env.recipient == address(0)) revert ZeroAddress();
        if (env.amount == 0) revert ZeroAmount();
        if (env.token != address(ausd)) revert WrongToken();
        if (block.timestamp >= env.validBefore) revert Expired();
        if (paymentUsed[env.paymentId]) revert PaymentAlreadyUsed();
        if (nonceUsed[env.payer][env.nonce]) revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_ENVELOPE_TYPEHASH,
                env.paymentId,
                env.payer,
                env.recipient,
                env.token,
                env.amount,
                env.requestId,
                env.resolutionHash,
                env.validBefore,
                env.nonce
            )
        );
        address signer = PrismEIP712.recover(PrismEIP712.digest(domainSeparator, structHash), prismSignature);
        if (signer == address(0) || signer != env.payer) revert BadEnvelopeSignature();

        // Effects before the external token call (also independently guarded by AUSD's own state).
        paymentUsed[env.paymentId] = true;
        nonceUsed[env.payer][env.nonce] = true;

        // The AUSD authorization is bound to the envelope: any tampered field breaks AUSD's ecrecover.
        ausd.transferWithAuthorization(env.payer, env.recipient, env.amount, 0, env.validBefore, env.nonce, v, r, s);

        emit PaymentSettled(env.paymentId, env.payer, env.recipient, env.amount, env.requestId, env.resolutionHash);
    }

    /// @notice Convenience view: the EIP-712 digest a payer signs for `env`.
    function envelopeDigest(PaymentEnvelope calldata env) external view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_ENVELOPE_TYPEHASH,
                env.paymentId,
                env.payer,
                env.recipient,
                env.token,
                env.amount,
                env.requestId,
                env.resolutionHash,
                env.validBefore,
                env.nonce
            )
        );
        return PrismEIP712.digest(domainSeparator, structHash);
    }
}
