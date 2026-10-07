// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrismP256Account} from "../src/PrismP256Account.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockP256Precompile} from "../src/mocks/MockP256Precompile.sol";

/// @notice PrismP256Account: a device-P256-authorized, relayer-sponsored smart account. These local
///         tests prove the ACCOUNT LOGIC (binding, replay, expiry) against a digest-keyed precompile
///         double; the real 0x0100 P-256 verification is exercised live on Monad
///         (scripts/verify/p256-account-live.mjs).
contract PrismP256AccountTest is Test {
    MockUSDC internal usdc;
    PrismP256Account internal account;
    address internal token;
    address internal recipient;

    // A real on-curve P-256 public key (the device passkey's key would go here).
    uint256 internal constant QX = 0x169c139ff5889d573327d25562a4aae488a874ca368e110bace208b4a22cc0ca;
    uint256 internal constant QY = 0x38cefadc3211b1dec8789b298d58e3985c4d09dc8e43a25e1c10cf5fa50539a9;

    bytes32 internal nonce = keccak256("nonce-1");
    uint256 internal amount = 1e6;
    uint256 internal validBefore;

    function setUp() public {
        usdc = new MockUSDC();
        token = address(usdc);
        account = new PrismP256Account(QX, QY);
        usdc.mint(address(account), 10e6);
        validBefore = block.timestamp + 300;
    }

    // Etch a precompile double at 0x0100 that "verifies" exactly the digest for these params.
    function _armPrecompileFor(uint256 amt, address rcpt, bytes32 n, uint256 vb) internal {
        bytes32 d = account.digest(token, rcpt, amt, n, vb);
        MockP256Precompile mock = new MockP256Precompile(d);
        vm.etch(address(0x0100), address(mock).code);
    }

    function testValidP256PaymentExecutes() public {
        _armPrecompileFor(amount, recipient, nonce, validBefore);
        account.pay(token, recipient, amount, nonce, validBefore, 1, 1);
        assertEq(usdc.balanceOf(recipient), amount, "USDC delivered on a valid P-256 authorization");
    }

    function testMutatedAmountRejected() public {
        _armPrecompileFor(amount, recipient, nonce, validBefore); // signature/digest bound to `amount`
        vm.expectRevert(PrismP256Account.BadP256Signature.selector);
        account.pay(token, recipient, amount + 1, nonce, validBefore, 1, 1); // different amount → different digest
    }

    function testMutatedRecipientRejected() public {
        _armPrecompileFor(amount, recipient, nonce, validBefore);
        vm.expectRevert(PrismP256Account.BadP256Signature.selector);
        account.pay(token, address(0xBEEF), amount, nonce, validBefore, 1, 1);
    }

    function testReplayRejected() public {
        _armPrecompileFor(amount, recipient, nonce, validBefore);
        account.pay(token, recipient, amount, nonce, validBefore, 1, 1);
        vm.expectRevert(PrismP256Account.NonceAlreadyUsed.selector);
        account.pay(token, recipient, amount, nonce, validBefore, 1, 1);
    }

    function testExpiredRejected() public {
        vm.warp(1000);
        uint256 vb = 999; // already in the past → expiry check (first in pay) must revert
        _armPrecompileFor(amount, recipient, nonce, vb);
        vm.expectRevert(PrismP256Account.Expired.selector);
        account.pay(token, recipient, amount, nonce, vb, 1, 1);
    }

    function testInvalidPublicKeyRejectedAtDeploy() public {
        vm.expectRevert(PrismP256Account.InvalidPublicKey.selector);
        new PrismP256Account(1, 1); // not on the P-256 curve
    }

    // --- P1.5: explicit scalar-range guard, non-vacuous even when the precompile would accept --------
    // The precompile double is armed to accept this digest, so these reversions come from the library's
    // own r, s ∈ [1, n-1] check rather than from the precompile.
    uint256 internal constant CURVE_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;

    function testZeroScalarRejected() public {
        _armPrecompileFor(amount, recipient, nonce, validBefore);
        vm.expectRevert(PrismP256Account.BadP256Signature.selector);
        account.pay(token, recipient, amount, nonce, validBefore, 1, 0); // s = 0 ∉ [1, n-1]
    }

    function testScalarAtCurveOrderRejected() public {
        _armPrecompileFor(amount, recipient, nonce, validBefore);
        vm.expectRevert(PrismP256Account.BadP256Signature.selector);
        account.pay(token, recipient, amount, nonce, validBefore, CURVE_N, 1); // r = n ∉ [1, n-1]
    }
}
