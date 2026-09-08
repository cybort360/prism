// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {PrismPaymentRouter} from "../src/PrismPaymentRouter.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice The contract-level guarantees a cross-chain send depends on.
///
/// A cross-chain send is an ordinary settlement whose recipient is an Aurora deposit address — an
/// address with no Prism identity behind it — and whose `resolutionHash` slot carries a route
/// binding instead of a resolver binding. No Solidity was added for that feature; these tests pin
/// the existing behaviour it relies on, so a future router change cannot silently break it.
contract PrismRouterExternalRecipientTest is Test {
    MockUSDC internal usdc;
    PrismPaymentRouter internal router;

    uint256 internal payerPk = 0xA11CE;
    address internal payer;
    address internal relayer = address(0xF00D);

    /// Stands in for an Aurora deposit address: an ordinary EOA, unknown to Prism.
    address internal depositAddress = address(0xDEDE);

    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function setUp() public {
        usdc = new MockUSDC();
        router = new PrismPaymentRouter(address(usdc));
        payer = vm.addr(payerPk);
        usdc.mint(payer, 1_000e6);
    }

    function _env(address recipient, uint256 amount, bytes32 routeHash, bytes32 nonce)
        internal
        view
        returns (PrismPaymentRouter.PaymentEnvelope memory env)
    {
        env = PrismPaymentRouter.PaymentEnvelope({
            paymentId: keccak256(abi.encode("aurora-send", nonce)),
            payer: payer,
            recipient: recipient,
            amount: amount,
            // A cross-chain send fulfils no Prism request.
            requestId: bytes32(0),
            resolutionHash: routeHash,
            validBefore: block.timestamp + 300,
            nonce: nonce
        });
    }

    function _settle(PrismPaymentRouter.PaymentEnvelope memory env) internal {
        (uint8 ev, bytes32 er, bytes32 es) = vm.sign(payerPk, router.envelopeDigest(env));
        bytes memory sig = abi.encodePacked(er, es, ev);
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, env.payer, address(router), env.amount, uint256(0), env.validBefore, env.nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(relayer);
        router.settle(env, sig, v, r, s);
    }

    /// The whole feature rests on this: the router forwards to `env.recipient` whoever that is, so
    /// funding an Aurora deposit address needs no new contract.
    function testForwardsExactAmountToAnExternalAddress() public {
        bytes32 routeHash = keccak256("route:arb/ETH/their-address/minOut");
        PrismPaymentRouter.PaymentEnvelope memory env = _env(depositAddress, 50e6, routeHash, bytes32(uint256(1)));

        vm.expectEmit(true, true, true, true);
        emit PrismPaymentRouter.PaymentSettled(env.paymentId, payer, depositAddress, 50e6, bytes32(0), routeHash);
        _settle(env);

        assertEq(usdc.balanceOf(depositAddress), 50e6, "the deposit address received the exact amount");
        assertEq(usdc.balanceOf(payer), 950e6);
        assertEq(usdc.balanceOf(address(router)), 0, "the router never retains funds");
        assertEq(payer.balance, 0, "the payer still holds no MON");
    }

    /// The route binding is what makes a cross-chain send safe: it is covered by the payer's
    /// signature, so rewriting the destination after approval invalidates it.
    function testRewritingTheRouteBindingInvalidatesTheSignature() public {
        PrismPaymentRouter.PaymentEnvelope memory env =
            _env(depositAddress, 50e6, keccak256("route:arb/ETH/their-address"), bytes32(uint256(2)));
        (uint8 ev, bytes32 er, bytes32 es) = vm.sign(payerPk, router.envelopeDigest(env));
        bytes memory sig = abi.encodePacked(er, es, ev);
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, env.payer, address(router), env.amount, uint256(0), env.validBefore, env.nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));

        // The backend is compromised and swaps the route for one that delivers elsewhere.
        env.resolutionHash = keccak256("route:base/USDC/attacker-address");

        vm.prank(relayer);
        vm.expectRevert(PrismPaymentRouter.BadEnvelopeSignature.selector);
        router.settle(env, sig, v, r, s);

        assertEq(usdc.balanceOf(depositAddress), 0, "no money moved");
    }

    /// Redirecting the funds themselves is equally covered — the recipient is signed too.
    function testRedirectingTheDepositAddressInvalidatesTheSignature() public {
        PrismPaymentRouter.PaymentEnvelope memory env =
            _env(depositAddress, 50e6, keccak256("route"), bytes32(uint256(3)));
        (uint8 ev, bytes32 er, bytes32 es) = vm.sign(payerPk, router.envelopeDigest(env));
        bytes memory sig = abi.encodePacked(er, es, ev);
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, env.payer, address(router), env.amount, uint256(0), env.validBefore, env.nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));

        env.recipient = address(0xBAD);

        vm.prank(relayer);
        vm.expectRevert(PrismPaymentRouter.BadEnvelopeSignature.selector);
        router.settle(env, sig, v, r, s);

        assertEq(usdc.balanceOf(address(0xBAD)), 0, "no money moved");
    }

    /// Replay protection is not weakened by the recipient being external: one quote funds once.
    function testAnExternalSendCannotBeReplayed() public {
        PrismPaymentRouter.PaymentEnvelope memory env =
            _env(depositAddress, 50e6, keccak256("route"), bytes32(uint256(4)));
        _settle(env);

        // Rebuild the signatures before arming expectRevert: it binds to the very next call, and the
        // digest view inside the helper would otherwise consume it.
        (uint8 ev, bytes32 er, bytes32 es) = vm.sign(payerPk, router.envelopeDigest(env));
        bytes memory sig = abi.encodePacked(er, es, ev);
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, env.payer, address(router), env.amount, uint256(0), env.validBefore, env.nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));

        vm.prank(relayer);
        vm.expectRevert(PrismPaymentRouter.PaymentAlreadyUsed.selector);
        router.settle(env, sig, v, r, s);

        assertEq(usdc.balanceOf(depositAddress), 50e6, "funded exactly once");
    }

    /// The route binding is opaque on-chain: no destination address, chain name, or asset id appears
    /// in the calldata or the event, only a hash of them.
    function testRouteBindingRevealsNothingAboutTheDestination() public {
        address theirArbAddress = 0x742d35Cc6634C0532925a3b844Bc454e4438f44e;
        bytes32 routeHash = keccak256(abi.encode(theirArbAddress, "arb", "nep141:arb.omft.near"));
        PrismPaymentRouter.PaymentEnvelope memory env = _env(depositAddress, 50e6, routeHash, bytes32(uint256(5)));

        vm.recordLogs();
        _settle(env);

        bytes memory needle = abi.encodePacked(theirArbAddress);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertFalse(_contains(logs[i].data, needle), "destination address leaked into event data");
            for (uint256 t = 0; t < logs[i].topics.length; t++) {
                assertFalse(_contains(abi.encodePacked(logs[i].topics[t]), needle), "destination leaked into a topic");
            }
        }
    }

    function _contains(bytes memory haystack, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0 || haystack.length < needle.length) return false;
        for (uint256 i = 0; i <= haystack.length - needle.length; i++) {
            bool match_ = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    match_ = false;
                    break;
                }
            }
            if (match_) return true;
        }
        return false;
    }
}
