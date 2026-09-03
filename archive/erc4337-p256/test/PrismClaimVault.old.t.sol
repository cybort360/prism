// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrismClaimVault} from "../src/PrismClaimVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockP256Precompile} from "../src/mocks/MockP256Precompile.sol";

contract PrismClaimVaultTest is Test {
    uint256 validR = 123;
    uint256 qx = 0x7a0d5f340f8e4cc8fb5ea548796c5efbcb6f3f11d0fa32298a58a89081241bd1;
    uint256 qy = 0x9f31e2e26bbb71853ff100a5a37f405ae2419c074d6d2ede70c17377feb3898c;
    address sender = address(0x51);
    address recipient = address(0x52);

    PrismClaimVault vault;
    MockUSDC usdc;

    function setUp() public {
        MockP256Precompile mock = new MockP256Precompile(validR);
        vm.etch(address(0x0100), address(mock).code);
        usdc = new MockUSDC();
        vault = new PrismClaimVault(address(this), address(usdc), qx, qy);
        usdc.mint(sender, 100_000_000);
    }

    function _fund(bytes32 claimId, uint64 expiry) internal {
        vm.startPrank(sender);
        usdc.approve(address(vault), 20_000_000);
        vault.createClaim(claimId, keccak256("random-recipient-ref"), address(usdc), 20_000_000, expiry);
        vm.stopPrank();
    }

    function _auth() internal view returns (bytes memory sig) {
        // The mocked precompile validates the `r` field. Production tests use live 0x0100.
        sig = abi.encode(validR, uint256(456));
    }

    function testRejectsUnsupportedToken() public {
        MockUSDC other = new MockUSDC();
        other.mint(sender, 20_000_000);
        vm.startPrank(sender);
        other.approve(address(vault), 20_000_000);
        vm.expectRevert(PrismClaimVault.UnsupportedToken.selector);
        vault.createClaim(keccak256("bad-token"), keccak256("random"), address(other), 20_000_000, uint64(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function testClaimOnce() public {
        bytes32 claimId = keccak256("claim-1");
        uint64 expiry = uint64(block.timestamp + 7 days);
        _fund(claimId, expiry);

        uint64 deadline = uint64(block.timestamp + 5 minutes);
        bytes memory sig = _auth();

        vm.prank(recipient);
        vault.claim(claimId, recipient, 1, 9, deadline, sig);
        assertEq(usdc.balanceOf(recipient), 20_000_000);

        vm.prank(recipient);
        vm.expectRevert(PrismClaimVault.ClaimNotFunded.selector);
        vault.claim(claimId, recipient, 1, 9, deadline, sig);
    }

    function testMutatedAuthorizationFails() public {
        bytes32 claimId = keccak256("claim-mutated");
        _fund(claimId, uint64(block.timestamp + 7 days));
        bytes memory sig = abi.encode(validR + 1, uint256(456));

        vm.prank(recipient);
        vm.expectRevert(PrismClaimVault.InvalidAuthorization.selector);
        vault.claim(claimId, recipient, 1, 9, uint64(block.timestamp + 5 minutes), sig);
    }

    function testWrongRecipientFails() public {
        bytes32 claimId = keccak256("claim-2");
        _fund(claimId, uint64(block.timestamp + 7 days));
        uint64 deadline = uint64(block.timestamp + 5 minutes);

        vm.prank(address(0xBAD));
        vm.expectRevert(PrismClaimVault.WrongRecipient.selector);
        vault.claim(claimId, recipient, 1, 9, deadline, _auth());
    }

    function testRefundAfterExpiry() public {
        bytes32 claimId = keccak256("claim-3");
        uint64 expiry = uint64(block.timestamp + 1 hours);
        _fund(claimId, expiry);
        uint256 beforeBalance = usdc.balanceOf(sender);

        vm.prank(sender);
        vm.expectRevert(PrismClaimVault.ClaimNotExpired.selector);
        vault.refund(claimId);

        vm.warp(expiry + 1);
        vm.prank(sender);
        vault.refund(claimId);
        assertEq(usdc.balanceOf(sender), beforeBalance + 20_000_000);
    }
}
