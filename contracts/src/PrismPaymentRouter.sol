// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC3009} from "./interfaces/IERC3009.sol";
import {PrismEIP712} from "./libraries/PrismEIP712.sol";

/// @title PrismPaymentRouter
/// @notice Gasless USDC direct-payment settlement. The payer's Mera account signs
///         two things: (1) a Prism EIP-712 `PaymentEnvelope` binding Prism metadata (paymentId,
///         recipient, amount, requestId, resolutionHash, validity, nonce) and (2) the token ERC-3009
///         `TransferWithAuthorization`. A relayer submits and pays MON, so the payer can hold
///         USDC > 0 and MON = 0.
/// @dev The router cross-binds the two signatures: the token authorization it submits is built from
///      the envelope fields (recipient = envelope.recipient, value = envelope.amount, nonce =
///      envelope.nonce), so a relayer that rewrites the recipient, amount, or reference invalidates
///      both the envelope signature and USDC's own `ecrecover`. requestId / resolutionHash are
///      opaque Prism identifiers and are NEVER phone-derived.
contract PrismPaymentRouter {
    IERC3009 public immutable usdc;
    bytes32 public immutable domainSeparator;

    bytes32 public constant PAYMENT_ENVELOPE_TYPEHASH = keccak256(
        "PaymentEnvelope(bytes32 paymentId,address payer,address recipient,uint256 amount,bytes32 requestId,bytes32 resolutionHash,uint256 validBefore,bytes32 nonce)"
    );

    struct PaymentEnvelope {
        bytes32 paymentId;
        address payer;
        address recipient;
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
    error Expired();
    error PaymentAlreadyUsed();
    error NonceAlreadyUsed();
    error BadEnvelopeSignature();

    constructor(address usdc_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = IERC3009(usdc_);
        domainSeparator = PrismEIP712.domainSeparator("PrismPaymentRouter", "1", address(this));
    }

    /// @notice Settle a gasless USDC payment described by a Prism `PaymentEnvelope`.
    /// @param env The Prism envelope, signed by `env.payer`'s Mera account (`prismSignature`).
    /// @param prismSignature secp256k1 signature over the EIP-712 envelope digest.
    /// @param v,r,s The payer's token ERC-3009 `TransferWithAuthorization` signature. Its authorized
    ///        `to`/`value`/`nonce` are taken from the envelope, so the two signatures cannot disagree.
    function settle(PaymentEnvelope calldata env, bytes calldata prismSignature, uint8 v, bytes32 r, bytes32 s)
        external
    {
        if (env.payer == address(0) || env.recipient == address(0)) revert ZeroAddress();
        if (env.amount == 0) revert ZeroAmount();
        if (block.timestamp >= env.validBefore) revert Expired();
        if (paymentUsed[env.paymentId]) revert PaymentAlreadyUsed();
        if (nonceUsed[env.payer][env.nonce]) revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_ENVELOPE_TYPEHASH,
                env.paymentId,
                env.payer,
                env.recipient,
                env.amount,
                env.requestId,
                env.resolutionHash,
                env.validBefore,
                env.nonce
            )
        );
        address signer = PrismEIP712.recover(PrismEIP712.digest(domainSeparator, structHash), prismSignature);
        if (signer == address(0) || signer != env.payer) revert BadEnvelopeSignature();

        // Effects before the external token call, also guarded by the token authorization state.
        paymentUsed[env.paymentId] = true;
        nonceUsed[env.payer][env.nonce] = true;

        // The USDC authorization is bound to the envelope. A changed transfer field fails.
        usdc.transferWithAuthorization(env.payer, env.recipient, env.amount, 0, env.validBefore, env.nonce, v, r, s);

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
