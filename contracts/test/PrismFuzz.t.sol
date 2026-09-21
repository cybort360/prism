// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrismPaymentRouter} from "../src/PrismPaymentRouter.sol";
import {PrismClaimVault} from "../src/PrismClaimVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Fuzz coverage over amounts, expiry, nonces, and signatures for both contracts.
contract PrismFuzzTest is Test {
    MockUSDC internal usdc;
    PrismPaymentRouter internal router;
    PrismClaimVault internal vault;

    uint256 internal payerPk = 0xA11CE;
    uint256 internal authorizerPk = 0xA07;
    uint256 internal recipientPk = 0xB0B;
    address internal payer;
    address internal recipient;
    address internal authorizer;
    address internal relayer = address(0xF00D);

    bytes32 internal constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function setUp() public {
        usdc = new MockUSDC();
        router = new PrismPaymentRouter(address(usdc));
        payer = vm.addr(payerPk);
        recipient = vm.addr(recipientPk);
        authorizer = vm.addr(authorizerPk);
        vault = new PrismClaimVault(address(this), address(usdc), authorizer);
        usdc.mint(payer, type(uint128).max);
    }

    // --- direct payment fuzz -------------------------------------------------

    function testFuzz_directPayment(uint256 amount, uint256 validForSecs, bytes32 nonce, bytes32 requestId) public {
        amount = bound(amount, 1, 1_000_000e6);
        validForSecs = bound(validForSecs, 1, 3650 days);
        PrismPaymentRouter.PaymentEnvelope memory env = PrismPaymentRouter.PaymentEnvelope({
            paymentId: keccak256(abi.encode(nonce, amount)),
            payer: payer,
            recipient: recipient,
            amount: amount,
            requestId: requestId,
            resolutionHash: keccak256(abi.encode("res", nonce)),
            validBefore: block.timestamp + validForSecs,
            nonce: nonce
        });
        (uint8 ev, bytes32 er, bytes32 es) = vm.sign(payerPk, router.envelopeDigest(env));
        bytes memory prismSig = abi.encodePacked(er, es, ev);
        bytes32 sh =
            keccak256(abi.encode(RECEIVE_TYPEHASH, payer, address(router), amount, uint256(0), env.validBefore, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh)));

        uint256 before = usdc.balanceOf(recipient);
        vm.prank(relayer);
        router.settle(env, prismSig, v, r, s);
        assertEq(usdc.balanceOf(recipient) - before, amount, "recipient credited exactly amount");
        assertTrue(router.paymentUsed(env.paymentId));
    }

    /// A signature from any key other than the payer must always be rejected.
    function testFuzz_wrongSignerAlwaysRejected(uint256 wrongPk, bytes32 nonce) public {
        wrongPk = bound(wrongPk, 1, type(uint128).max);
        vm.assume(vm.addr(wrongPk) != payer);
        PrismPaymentRouter.PaymentEnvelope memory env = PrismPaymentRouter.PaymentEnvelope({
            paymentId: keccak256(abi.encode("p", nonce)),
            payer: payer,
            recipient: recipient,
            amount: 10e6,
            requestId: bytes32(0),
            resolutionHash: bytes32(0),
            validBefore: block.timestamp + 300,
            nonce: nonce
        });
        (uint8 ev, bytes32 er, bytes32 es) = vm.sign(wrongPk, router.envelopeDigest(env));
        bytes memory badSig = abi.encodePacked(er, es, ev);
        bytes32 sh = keccak256(
            abi.encode(RECEIVE_TYPEHASH, payer, address(router), uint256(10e6), uint256(0), env.validBefore, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh)));
        vm.prank(relayer);
        vm.expectRevert(PrismPaymentRouter.BadEnvelopeSignature.selector);
        router.settle(env, badSig, v, r, s);
    }

    // --- claim lifecycle fuzz ------------------------------------------------

    function testFuzz_claimLifecycle(uint256 amount, uint256 ttl, bytes32 idSeed) public {
        amount = bound(amount, 1, 1_000_000e6);
        ttl = bound(ttl, 1 hours, 365 days);
        bytes32 claimId = keccak256(abi.encode("claim", idSeed));
        bytes32 ref = keccak256(abi.encode("ref", idSeed));
        uint256 expiry = block.timestamp + ttl;

        // fund
        usdc.mint(payer, amount);
        bytes32 nonce = vault.fundingNonce(claimId, ref, amount, payer, expiry);
        uint256 vb = block.timestamp + 300;
        bytes32 fsh = keccak256(abi.encode(RECEIVE_TYPEHASH, payer, address(vault), amount, uint256(0), vb, nonce));
        (uint8 fv, bytes32 fr, bytes32 fs) =
            vm.sign(payerPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), fsh)));
        vm.prank(relayer);
        vault.fundClaim(claimId, ref, payer, amount, expiry, 0, vb, nonce, fv, fr, fs);
        assertEq(usdc.balanceOf(address(vault)), amount);

        // claim
        uint256 eligExpiry = expiry; // within claim validity
        bytes32 eligNonce = keccak256(abi.encode("e", idSeed));
        (uint8 av, bytes32 ar, bytes32 as_) =
            vm.sign(authorizerPk, vault.eligibilityDigest(claimId, recipient, 1, eligExpiry, eligNonce));
        (uint8 rv, bytes32 rr, bytes32 rs) = vm.sign(recipientPk, vault.claimIntentDigest(claimId, recipient));
        vm.prank(relayer);
        vault.claim(
            claimId, recipient, 1, eligExpiry, eligNonce, abi.encodePacked(ar, as_, av), abi.encodePacked(rr, rs, rv)
        );
        assertEq(usdc.balanceOf(recipient), amount);
        assertEq(usdc.balanceOf(address(vault)), 0, "vault fully drained to claimant");
    }
}
