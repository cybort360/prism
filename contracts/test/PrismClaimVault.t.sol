// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrismClaimVault} from "../src/PrismClaimVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice Pre-user claim lifecycle: gasless ERC-3009 funding, dual-signature collection, and
///         refund-after-expiry — with no phone-derived data and all failure paths closing.
contract PrismClaimVaultTest is Test {
    MockUSDC internal usdc;
    PrismClaimVault internal vault;

    uint256 internal senderPk = 0x5E4DE7;
    uint256 internal authorizerPk = 0xA07;
    uint256 internal recipientPk = 0xB0B;
    address internal sender;
    address internal authorizer;
    address internal recipient;
    address internal relayer = address(0xF00D);

    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bytes32 internal claimId = keccak256("claim-1");
    bytes32 internal recipientRef = keccak256("recipient-ref-1");
    uint256 internal amount = 50e6;

    function setUp() public {
        usdc = new MockUSDC();
        sender = vm.addr(senderPk);
        authorizer = vm.addr(authorizerPk);
        recipient = vm.addr(recipientPk);
        vault = new PrismClaimVault(address(this), address(usdc), authorizer);
        usdc.mint(sender, 1_000e6);
    }

    function _fund(bytes32 id, bytes32 ref, uint256 amt, uint256 expiry) internal {
        bytes32 nonce = vault.fundingNonce(id, ref, amt, sender);
        uint256 validBefore = block.timestamp + 300;
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, sender, address(vault), amt, uint256(0), validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(senderPk, digest);
        vm.prank(relayer);
        vault.fundClaim(id, ref, sender, amt, expiry, 0, validBefore, nonce, v, r, s);
    }

    function _eligSig(bytes32 id, address rcpt, uint256 aliasVersion, uint256 expiry, bytes32 nonce, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.eligibilityDigest(id, rcpt, aliasVersion, expiry, nonce));
        return abi.encodePacked(r, s, v);
    }

    function _intentSig(bytes32 id, address rcpt, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.claimIntentDigest(id, rcpt));
        return abi.encodePacked(r, s, v);
    }

    function testClaimFundingSucceeds() public {
        _fund(claimId, recipientRef, amount, block.timestamp + 7 days);
        assertEq(usdc.balanceOf(address(vault)), amount);
        (,, address s_, uint256 a_,, PrismClaimVault.ClaimStatus st_) = vault.claims(claimId);
        assertEq(s_, sender);
        assertEq(a_, amount);
        assertEq(uint256(st_), uint256(PrismClaimVault.ClaimStatus.Funded));
    }

    function testRandomRecipientReferenceHasNoPhoneCorrelation() public {
        // Two claims "to the same person" carry independent random references; the vault stores only
        // what it is given and never derives anything from a phone number.
        _fund(keccak256("c1"), keccak256("ref-A"), 10e6, block.timestamp + 7 days);
        _fund(keccak256("c2"), keccak256("ref-B"), 10e6, block.timestamp + 7 days);
        (, bytes32 refA,,,,) = vault.claims(keccak256("c1"));
        (, bytes32 refB,,,,) = vault.claims(keccak256("c2"));
        assertTrue(refA != refB);
        assertEq(refA, keccak256("ref-A"));
    }

    function testCorrectClaimantSucceeds() public {
        _fund(claimId, recipientRef, amount, block.timestamp + 7 days);
        uint256 eligExpiry = block.timestamp + 3600;
        bytes32 eligNonce = keccak256("elig-1");
        bytes memory elig = _eligSig(claimId, recipient, 1, eligExpiry, eligNonce, authorizerPk);
        bytes memory intent = _intentSig(claimId, recipient, recipientPk);
        vm.prank(relayer);
        vault.claim(claimId, recipient, 1, eligExpiry, eligNonce, elig, intent);
        assertEq(usdc.balanceOf(recipient), amount);
    }

    function testWrongClaimantFails() public {
        _fund(claimId, recipientRef, amount, block.timestamp + 7 days);
        uint256 eligExpiry = block.timestamp + 3600;
        bytes32 eligNonce = keccak256("elig-2");
        // Backend vouches for `recipient`, but an attacker supplies their OWN intent signature.
        bytes memory elig = _eligSig(claimId, recipient, 1, eligExpiry, eligNonce, authorizerPk);
        bytes memory intent = _intentSig(claimId, recipient, 0xBADBAD);
        vm.prank(relayer);
        vm.expectRevert(PrismClaimVault.BadRecipientIntent.selector);
        vault.claim(claimId, recipient, 1, eligExpiry, eligNonce, elig, intent);
    }

    function testForgedEligibilityFails() public {
        _fund(claimId, recipientRef, amount, block.timestamp + 7 days);
        uint256 eligExpiry = block.timestamp + 3600;
        bytes32 eligNonce = keccak256("elig-3");
        bytes memory forged = _eligSig(claimId, recipient, 1, eligExpiry, eligNonce, 0xBADBAD); // not the authorizer
        bytes memory intent = _intentSig(claimId, recipient, recipientPk);
        vm.prank(relayer);
        vm.expectRevert(PrismClaimVault.BadEligibility.selector);
        vault.claim(claimId, recipient, 1, eligExpiry, eligNonce, forged, intent);
    }

    function testExpiredEligibilityFails() public {
        _fund(claimId, recipientRef, amount, block.timestamp + 7 days);
        uint256 eligExpiry = block.timestamp + 3600;
        bytes32 eligNonce = keccak256("elig-4");
        bytes memory elig = _eligSig(claimId, recipient, 1, eligExpiry, eligNonce, authorizerPk);
        bytes memory intent = _intentSig(claimId, recipient, recipientPk);
        vm.warp(eligExpiry + 1);
        vm.prank(relayer);
        vm.expectRevert(PrismClaimVault.EligibilityExpired.selector);
        vault.claim(claimId, recipient, 1, eligExpiry, eligNonce, elig, intent);
    }

    function testDoubleClaimFails() public {
        _fund(claimId, recipientRef, amount, block.timestamp + 7 days);
        uint256 eligExpiry = block.timestamp + 3600;
        bytes memory elig = _eligSig(claimId, recipient, 1, eligExpiry, keccak256("e5"), authorizerPk);
        bytes memory intent = _intentSig(claimId, recipient, recipientPk);
        vm.prank(relayer);
        vault.claim(claimId, recipient, 1, eligExpiry, keccak256("e5"), elig, intent);

        bytes memory elig2 = _eligSig(claimId, recipient, 1, eligExpiry, keccak256("e5b"), authorizerPk);
        vm.prank(relayer);
        vm.expectRevert(PrismClaimVault.NotFunded.selector);
        vault.claim(claimId, recipient, 1, eligExpiry, keccak256("e5b"), elig2, intent);
    }

    function testRefundBeforeExpiryFails() public {
        _fund(claimId, recipientRef, amount, block.timestamp + 7 days);
        vm.expectRevert(PrismClaimVault.NotYetExpired.selector);
        vault.refund(claimId);
    }

    function testRefundAfterExpirySucceeds() public {
        uint256 expiry = block.timestamp + 7 days;
        _fund(claimId, recipientRef, amount, expiry);
        vm.warp(expiry + 1);
        vault.refund(claimId);
        assertEq(usdc.balanceOf(sender), 1_000e6, "sender made whole");
    }

    function testClaimAfterRefundFails() public {
        uint256 expiry = block.timestamp + 7 days;
        _fund(claimId, recipientRef, amount, expiry);
        vm.warp(expiry + 1);
        vault.refund(claimId);
        uint256 eligExpiry = block.timestamp + 3600;
        bytes memory elig = _eligSig(claimId, recipient, 1, eligExpiry, keccak256("e6"), authorizerPk);
        bytes memory intent = _intentSig(claimId, recipient, recipientPk);
        vm.prank(relayer);
        vm.expectRevert(PrismClaimVault.NotFunded.selector);
        vault.claim(claimId, recipient, 1, eligExpiry, keccak256("e6"), elig, intent);
    }

    function testDoubleRefundFails() public {
        uint256 expiry = block.timestamp + 7 days;
        _fund(claimId, recipientRef, amount, expiry);
        vm.warp(expiry + 1);
        vault.refund(claimId);
        vm.expectRevert(PrismClaimVault.NotFunded.selector);
        vault.refund(claimId);
    }

    function testRefundDestinationCannotBeChanged() public {
        uint256 expiry = block.timestamp + 7 days;
        _fund(claimId, recipientRef, amount, expiry);
        vm.warp(expiry + 1);
        // An attacker triggers the refund; funds can only ever go back to the original sender.
        vm.prank(address(0xBAD));
        vault.refund(claimId);
        assertEq(usdc.balanceOf(sender), 1_000e6);
        assertEq(usdc.balanceOf(address(0xBAD)), 0);
    }
}
