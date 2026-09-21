// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrismClaimVault} from "../src/PrismClaimVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Multi-claim isolation (audit P1). For any two claims Ci != Cj, a valid state transition on
///         Ci must never change the status, claimability, or refundability of Cj — across every
///         sender/recipient fan-in/fan-out, and including a reused eligibility nonce (C-01).
contract PrismClaimIsolationTest is Test {
    MockUSDC internal usdc;
    PrismClaimVault internal vault;
    uint256 internal authorizerPk = 0xA07;
    address internal authorizer;
    address internal relayer = address(0xF00D);
    uint256 internal constant R = 0xB0B; // a single recipient key reused across fan-in tests

    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function setUp() public {
        usdc = new MockUSDC();
        authorizer = vm.addr(authorizerPk);
        vault = new PrismClaimVault(address(this), address(usdc), authorizer);
    }

    function _fundFrom(uint256 senderPk, bytes32 id, bytes32 ref, uint256 amt, uint256 expiry) internal {
        address sender = vm.addr(senderPk);
        usdc.mint(sender, amt);
        bytes32 nonce = vault.fundingNonce(id, ref, amt, sender, expiry);
        uint256 validBefore = block.timestamp + 300;
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, sender, address(vault), amt, uint256(0), validBefore, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(senderPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(relayer);
        vault.fundClaim(id, ref, sender, amt, expiry, 0, validBefore, nonce, v, r, s);
    }

    function _claim(bytes32 id, uint256 recipientPk, bytes32 eligNonce) internal {
        address rcpt = vm.addr(recipientPk);
        uint256 eligExpiry = block.timestamp + 30 days;
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(authorizerPk, vault.eligibilityDigest(id, rcpt, 1, eligExpiry, eligNonce));
        (uint8 iv, bytes32 ir, bytes32 is_) = vm.sign(recipientPk, vault.claimIntentDigest(id, rcpt));
        vm.prank(relayer);
        vault.claim(id, rcpt, 1, eligExpiry, eligNonce, abi.encodePacked(ar, as_, av), abi.encodePacked(ir, is_, iv));
    }

    function _status(bytes32 id) internal view returns (PrismClaimVault.ClaimStatus st) {
        (,,,,, st) = vault.claims(id);
    }

    function _funded(bytes32 id) internal view returns (bool) { return _status(id) == PrismClaimVault.ClaimStatus.Funded; }
    function _claimed(bytes32 id) internal view returns (bool) { return _status(id) == PrismClaimVault.ClaimStatus.Claimed; }

    // Test A — many senders -> one recipient. Claiming C2 leaves C1 and C3 funded.
    function testManySendersOneRecipient() public {
        bytes32 c1 = keccak256("A1"); bytes32 c2 = keccak256("A2"); bytes32 c3 = keccak256("A3");
        _fundFrom(0x51, c1, keccak256("Ar1"), 10e6, block.timestamp + 7 days);
        _fundFrom(0x52, c2, keccak256("Ar2"), 20e6, block.timestamp + 7 days);
        _fundFrom(0x53, c3, keccak256("Ar3"), 30e6, block.timestamp + 7 days);

        _claim(c2, R, keccak256("An2"));

        assertTrue(_funded(c1));
        assertTrue(_claimed(c2));
        assertTrue(_funded(c3));
        assertEq(usdc.balanceOf(vm.addr(R)), 20e6);
    }

    // Test B/C — one sender -> the same recipient repeatedly, claimed out of order, receives the sum.
    function testOneSenderSameRecipientOutOfOrder() public {
        bytes32 c1 = keccak256("C1"); bytes32 c2 = keccak256("C2"); bytes32 c3 = keccak256("C3");
        _fundFrom(0x51, c1, keccak256("Cr1"), 10e6, block.timestamp + 7 days);
        _fundFrom(0x51, c2, keccak256("Cr2"), 20e6, block.timestamp + 7 days);
        _fundFrom(0x51, c3, keccak256("Cr3"), 30e6, block.timestamp + 7 days);

        _claim(c2, R, keccak256("Cn2"));
        _claim(c1, R, keccak256("Cn1"));
        _claim(c3, R, keccak256("Cn3"));

        assertTrue(_claimed(c1) && _claimed(c2) && _claimed(c3));
        assertEq(usdc.balanceOf(vm.addr(R)), 60e6, "recipient receives the sum of all claims");
    }

    // Test D — refunding one claim does not touch its siblings; they stay claimable.
    function testSiblingRefundIsolation() public {
        bytes32 c1 = keccak256("D1"); bytes32 c2 = keccak256("D2"); bytes32 c3 = keccak256("D3");
        _fundFrom(0x51, c1, keccak256("Dr1"), 10e6, block.timestamp + 7 days);
        _fundFrom(0x51, c2, keccak256("Dr2"), 20e6, block.timestamp + 1 hours); // expires sooner
        _fundFrom(0x51, c3, keccak256("Dr3"), 30e6, block.timestamp + 7 days);

        vm.warp(block.timestamp + 2 hours); // past C2 expiry, before C1/C3
        vault.refund(c2);

        assertEq(uint256(_status(c2)), uint256(PrismClaimVault.ClaimStatus.Refunded));
        // A sibling remains claimable and another remains funded — refund of C2 changed neither.
        _claim(c1, R, keccak256("Dn1"));
        assertTrue(_claimed(c1));
        assertTrue(_funded(c3));
    }

    // Test E (C-01) — the same eligibility nonce on two different claims. With the per-claim nonce
    // namespace, claiming C1 does not block claiming C2 with the same nonce.
    function testEligibilityNonceIsScopedPerClaim() public {
        bytes32 c1 = keccak256("E1"); bytes32 c2 = keccak256("E2");
        _fundFrom(0x51, c1, keccak256("Er1"), 10e6, block.timestamp + 7 days);
        _fundFrom(0x52, c2, keccak256("Er2"), 10e6, block.timestamp + 7 days);

        bytes32 shared = keccak256("shared-eligibility-nonce");
        _claim(c1, R, shared);
        _claim(c2, R, shared); // before C-01 this reverted EligibilityReused

        assertTrue(_claimed(c1) && _claimed(c2));
    }
}
