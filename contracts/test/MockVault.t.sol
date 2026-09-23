// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockVault} from "../src/mocks/MockVault.sol";

contract MockVaultTest is Test {
    MockUSDC usdc;
    MockVault vault;
    uint256 userPk = 0xA11CE;
    address user;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new MockVault(address(usdc));
        user = vm.addr(userPk);
        usdc.mint(user, 1_000_000000); // 1,000 USDC
    }

    // ---- helpers ----------------------------------------------------------
    function _usdcDomain() internal view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("USDC")), keccak256(bytes("2")), block.chainid, address(usdc)
        ));
    }

    function _signReceive(uint256 pk, address from, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        internal view returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(
            usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, va, vb, nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _usdcDomain(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function _signRedeem(uint256 pk, address owner_, uint256 shares, uint256 va, uint256 vb, bytes32 nonce)
        internal view returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(
            vault.REDEEM_WITH_AUTHORIZATION_TYPEHASH(), owner_, shares, va, vb, nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    // ---- tests ------------------------------------------------------------
    function test_firstDepositMintsOneToOne() public {
        bytes32 nonce = keccak256("d1");
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(userPk, user, address(vault), 100_000000, 0, block.timestamp + 3600, nonce);
        uint256 shares = vault.depositWithAuthorization(user, 100_000000, 0, block.timestamp + 3600, nonce, v, r, s);
        assertEq(shares, 100_000000);
        assertEq(vault.balanceOf(user), 100_000000);
        assertEq(usdc.balanceOf(address(vault)), 100_000000);
        assertEq(usdc.balanceOf(user), 900_000000);
    }

    function test_yieldRaisesRedeemValue() public {
        bytes32 nonce = keccak256("d2");
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(userPk, user, address(vault), 100_000000, 0, block.timestamp + 3600, nonce);
        vault.depositWithAuthorization(user, 100_000000, 0, block.timestamp + 3600, nonce, v, r, s);

        vault.simulateYield(10_000000); // +10 USDC into the vault -> +10% share price

        assertEq(vault.convertToAssets(100_000000), 110_000000);

        bytes32 rn = keccak256("r1");
        (uint8 rv, bytes32 rr, bytes32 rs) = _signRedeem(userPk, user, 100_000000, 0, block.timestamp + 3600, rn);
        uint256 assets = vault.redeemWithAuthorization(user, 100_000000, 0, block.timestamp + 3600, rn, rv, rr, rs);
        assertEq(assets, 110_000000);
        assertEq(vault.balanceOf(user), 0);
        assertEq(usdc.balanceOf(user), 1010_000000); // 1000 - 100 deposited + 110 redeemed
    }

    function test_redeemRejectsReusedNonce() public {
        bytes32 nonce = keccak256("d3");
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(userPk, user, address(vault), 50_000000, 0, block.timestamp + 3600, nonce);
        vault.depositWithAuthorization(user, 50_000000, 0, block.timestamp + 3600, nonce, v, r, s);
        bytes32 rn = keccak256("r2");
        (uint8 rv, bytes32 rr, bytes32 rs) = _signRedeem(userPk, user, 25_000000, 0, block.timestamp + 3600, rn);
        vault.redeemWithAuthorization(user, 25_000000, 0, block.timestamp + 3600, rn, rv, rr, rs);
        vm.expectRevert(MockVault.AuthorizationUsed.selector);
        vault.redeemWithAuthorization(user, 25_000000, 0, block.timestamp + 3600, rn, rv, rr, rs);
    }

    function test_simulateYieldOwnerOnly() public {
        vm.prank(user);
        vm.expectRevert(MockVault.NotOwner.selector);
        vault.simulateYield(1_000000);
    }
}
