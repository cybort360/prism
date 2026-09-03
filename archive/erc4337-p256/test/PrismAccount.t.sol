// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrismAccount} from "../src/PrismAccount.sol";
import {PackedUserOperation} from "../src/interfaces/PackedUserOperation.sol";
import {MockP256Precompile} from "../src/mocks/MockP256Precompile.sol";

contract Target {
    uint256 public value;
    function set(uint256 v) external { value = v; }
}

contract PrismAccountTest is Test {
    address entryPoint = address(0xE4337);
    uint256 validR = 123;
    // Known valid P-256 public point (generated fixture).
    uint256 qx = 0x7a0d5f340f8e4cc8fb5ea548796c5efbcb6f3f11d0fa32298a58a89081241bd1;
    uint256 qy = 0x9f31e2e26bbb71853ff100a5a37f405ae2419c074d6d2ede70c17377feb3898c;

    PrismAccount account;

    function setUp() public {
        account = new PrismAccount(entryPoint, qx, qy);
        MockP256Precompile mock = new MockP256Precompile(validR);
        vm.etch(address(0x0100), address(mock).code);
    }

    function _userOp(uint256 r) internal view returns (PackedUserOperation memory op) {
        op.sender = address(account);
        op.signature = abi.encode(r, uint256(456));
    }

    function testValidateAcceptsP256FixtureShape() public {
        PackedUserOperation memory op = _userOp(validR);
        vm.prank(entryPoint);
        uint256 result = account.validateUserOp(op, keccak256("userop"), 0);
        assertEq(result, 0);
    }

    function testValidateRejectsMutatedSignature() public {
        PackedUserOperation memory op = _userOp(validR + 1);
        vm.prank(entryPoint);
        uint256 result = account.validateUserOp(op, keccak256("userop"), 0);
        assertEq(result, 1);
    }

    function testValidateRejectsWrongSender() public {
        PackedUserOperation memory op = _userOp(validR);
        op.sender = address(0x1234);
        vm.prank(entryPoint);
        assertEq(account.validateUserOp(op, keccak256("userop"), 0), 1);
    }

    function testRotateKeyRequiresSelfCall() public {
        vm.expectRevert(PrismAccount.NotSelf.selector);
        account.rotateP256Key(qx, qy);
        vm.prank(entryPoint);
        account.execute(address(account), 0, abi.encodeCall(PrismAccount.rotateP256Key, (qx, qy)));
        assertEq(account.qx(), qx);
    }

    function testOnlyEntryPointExecutes() public {
        Target target = new Target();
        vm.expectRevert(PrismAccount.NotEntryPoint.selector);
        account.execute(address(target), 0, abi.encodeCall(Target.set, (7)));

        vm.prank(entryPoint);
        account.execute(address(target), 0, abi.encodeCall(Target.set, (7)));
        assertEq(target.value(), 7);
    }
}
