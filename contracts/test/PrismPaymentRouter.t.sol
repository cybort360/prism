// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {PrismPaymentRouter} from "../src/PrismPaymentRouter.sol";
import {MockAUSD} from "../src/mocks/MockAUSD.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Direct AUSD payment invariants on the Prism envelope + ERC-3009 gasless path.
contract PrismPaymentRouterTest is Test {
    MockAUSD internal ausd;
    MockUSDC internal usdc;
    PrismPaymentRouter internal router;

    uint256 internal payerPk = 0xA11CE;
    address internal payer;
    address internal recipient = address(0xB0B);
    address internal relayer = address(0xF00D);

    bytes32 internal constant TRANSFER_TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

    function setUp() public {
        ausd = new MockAUSD();
        usdc = new MockUSDC();
        router = new PrismPaymentRouter(address(ausd), address(usdc));
        payer = vm.addr(payerPk);
        ausd.mint(payer, 1_000e6);
    }

    function _env(uint256 amount, bytes32 requestId, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (PrismPaymentRouter.PaymentEnvelope memory env)
    {
        env = PrismPaymentRouter.PaymentEnvelope({
            paymentId: keccak256(abi.encode("pay", nonce)),
            payer: payer,
            recipient: recipient,
            token: address(ausd),
            amount: amount,
            requestId: requestId,
            resolutionHash: keccak256(abi.encode("opaque-resolution", nonce)),
            validBefore: validBefore,
            nonce: nonce
        });
    }

    function _signEnvelope(PrismPaymentRouter.PaymentEnvelope memory env, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, router.envelopeDigest(env));
        return abi.encodePacked(r, s, v);
    }

    function _signAusd(PrismPaymentRouter.PaymentEnvelope memory env, uint256 pk)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(TRANSFER_TYPEHASH, env.payer, env.recipient, env.amount, uint256(0), env.validBefore, env.nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ausd.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function _signUsdc(PrismPaymentRouter.PaymentEnvelope memory env, uint256 pk)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(TRANSFER_TYPEHASH, env.payer, env.recipient, env.amount, uint256(0), env.validBefore, env.nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function _settle(PrismPaymentRouter.PaymentEnvelope memory env) internal {
        bytes memory sig = _signEnvelope(env, payerPk);
        (uint8 v, bytes32 r, bytes32 s) = _signAusd(env, payerPk);
        vm.prank(relayer);
        router.settle(env, sig, v, r, s);
    }

    function testDirectPaymentSucceeds() public {
        PrismPaymentRouter.PaymentEnvelope memory env = _env(25e6, keccak256("req-1"), block.timestamp + 300, bytes32(uint256(1)));
        vm.expectEmit(true, true, true, true);
        emit PrismPaymentRouter.PaymentSettled(env.paymentId, payer, recipient, address(ausd), 25e6, env.requestId, env.resolutionHash);
        _settle(env);
        assertEq(ausd.balanceOf(recipient), 25e6);
        assertEq(ausd.balanceOf(payer), 975e6);
    }


    function testUsdcPaymentSucceeds() public {
        usdc.mint(payer, 100e6);
        PrismPaymentRouter.PaymentEnvelope memory env = _env(20e6, keccak256("req-usdc"), block.timestamp + 300, bytes32(uint256(12)));
        env.token = address(usdc);
        bytes memory sig = _signEnvelope(env, payerPk);
        (uint8 v, bytes32 r, bytes32 s) = _signUsdc(env, payerPk);
        vm.prank(relayer);
        router.settle(env, sig, v, r, s);
        assertEq(usdc.balanceOf(recipient), 20e6);
        assertEq(ausd.balanceOf(recipient), 0);
    }

    function testPayerOwnsZeroMon() public {
        assertEq(payer.balance, 0, "payer holds no MON");
        _settle(_env(25e6, keccak256("req"), block.timestamp + 300, bytes32(uint256(2))));
        assertEq(ausd.balanceOf(recipient), 25e6);
    }

    function testWrongSignerRejected() public {
        PrismPaymentRouter.PaymentEnvelope memory env = _env(25e6, keccak256("req"), block.timestamp + 300, bytes32(uint256(3)));
        bytes memory badSig = _signEnvelope(env, 0xBADBAD); // envelope signed by the wrong key
        (uint8 v, bytes32 r, bytes32 s) = _signAusd(env, payerPk);
        vm.prank(relayer);
        vm.expectRevert(PrismPaymentRouter.BadEnvelopeSignature.selector);
        router.settle(env, badSig, v, r, s);
    }

    function testModifiedAmountRejected() public {
        PrismPaymentRouter.PaymentEnvelope memory env = _env(25e6, keccak256("req"), block.timestamp + 300, bytes32(uint256(4)));
        bytes memory sig = _signEnvelope(env, payerPk);
        (uint8 v, bytes32 r, bytes32 s) = _signAusd(env, payerPk);
        env.amount = 26e6; // tamper after signing
        vm.prank(relayer);
        vm.expectRevert(PrismPaymentRouter.BadEnvelopeSignature.selector);
        router.settle(env, sig, v, r, s);
    }

    function testModifiedRecipientRejected() public {
        PrismPaymentRouter.PaymentEnvelope memory env = _env(25e6, keccak256("req"), block.timestamp + 300, bytes32(uint256(5)));
        bytes memory sig = _signEnvelope(env, payerPk);
        (uint8 v, bytes32 r, bytes32 s) = _signAusd(env, payerPk);
        env.recipient = address(0xBAD);
        vm.prank(relayer);
        vm.expectRevert(PrismPaymentRouter.BadEnvelopeSignature.selector);
        router.settle(env, sig, v, r, s);
    }

    function testModifiedTokenRejected() public {
        PrismPaymentRouter.PaymentEnvelope memory env = _env(25e6, keccak256("req"), block.timestamp + 300, bytes32(uint256(13)));
        bytes memory sig = _signEnvelope(env, payerPk);
        (uint8 v, bytes32 r, bytes32 s) = _signAusd(env, payerPk);
        env.token = address(usdc);
        vm.prank(relayer);
        vm.expectRevert(PrismPaymentRouter.BadEnvelopeSignature.selector);
        router.settle(env, sig, v, r, s);
    }

    function testModifiedRequestIdRejected() public {
        PrismPaymentRouter.PaymentEnvelope memory env = _env(25e6, keccak256("req"), block.timestamp + 300, bytes32(uint256(6)));
        bytes memory sig = _signEnvelope(env, payerPk);
        (uint8 v, bytes32 r, bytes32 s) = _signAusd(env, payerPk);
        env.requestId = keccak256("different-request"); // metadata cannot be mutated after signature
        vm.prank(relayer);
        vm.expectRevert(PrismPaymentRouter.BadEnvelopeSignature.selector);
        router.settle(env, sig, v, r, s);
    }

    function testExpiredPaymentRejected() public {
        uint256 validBefore = block.timestamp + 300;
        PrismPaymentRouter.PaymentEnvelope memory env = _env(25e6, keccak256("req"), validBefore, bytes32(uint256(7)));
        bytes memory sig = _signEnvelope(env, payerPk);
        (uint8 v, bytes32 r, bytes32 s) = _signAusd(env, payerPk);
        vm.warp(validBefore + 1);
        vm.prank(relayer);
        vm.expectRevert(PrismPaymentRouter.Expired.selector);
        router.settle(env, sig, v, r, s);
    }

    function testReplayRejected() public {
        PrismPaymentRouter.PaymentEnvelope memory env = _env(25e6, keccak256("req"), block.timestamp + 300, bytes32(uint256(8)));
        _settle(env);
        bytes memory sig = _signEnvelope(env, payerPk);
        (uint8 v, bytes32 r, bytes32 s) = _signAusd(env, payerPk);
        vm.prank(relayer);
        vm.expectRevert(PrismPaymentRouter.PaymentAlreadyUsed.selector);
        router.settle(env, sig, v, r, s);
    }

    function testPaymentIdReuseRejected() public {
        PrismPaymentRouter.PaymentEnvelope memory env = _env(25e6, keccak256("req"), block.timestamp + 300, bytes32(uint256(9)));
        _settle(env);
        // New nonce (fresh AUSD authorization) but the same paymentId must still be rejected.
        PrismPaymentRouter.PaymentEnvelope memory env2 = env;
        env2.nonce = bytes32(uint256(9999));
        bytes memory sig = _signEnvelope(env2, payerPk);
        (uint8 v, bytes32 r, bytes32 s) = _signAusd(env2, payerPk);
        vm.prank(relayer);
        vm.expectRevert(PrismPaymentRouter.PaymentAlreadyUsed.selector);
        router.settle(env2, sig, v, r, s);
    }

    function testUnsupportedTokenRejected() public {
        PrismPaymentRouter.PaymentEnvelope memory env = _env(25e6, keccak256("req"), block.timestamp + 300, bytes32(uint256(10)));
        env.token = address(0xDEAD);
        bytes memory sig = _signEnvelope(env, payerPk); // signs the (wrong-token) envelope honestly
        (uint8 v, bytes32 r, bytes32 s) = _signAusd(env, payerPk);
        vm.prank(relayer);
        vm.expectRevert(PrismPaymentRouter.WrongToken.selector);
        router.settle(env, sig, v, r, s);
    }

    function testResolutionHashIsOpaqueMetadata() public {
        // resolutionHash is a Prism-supplied opaque reference emitted verbatim; the contract never
        // derives it and never sees a phone number.
        PrismPaymentRouter.PaymentEnvelope memory env = _env(25e6, keccak256("req"), block.timestamp + 300, bytes32(uint256(11)));
        vm.recordLogs();
        _settle(env);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == PrismPaymentRouter.PaymentSettled.selector) {
                (, uint256 emittedAmount,, bytes32 resolutionHash) =
                    abi.decode(logs[i].data, (address, uint256, bytes32, bytes32));
                assertEq(emittedAmount, env.amount);
                assertEq(resolutionHash, env.resolutionHash);
                found = true;
            }
        }
        assertTrue(found, "PaymentSettled emitted");
    }
}
