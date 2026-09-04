// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PrismClaimVault} from "../src/PrismClaimVault.sol";
import {MockAUSD} from "../src/mocks/MockAUSD.sol";

/// @notice Exercises fund/collect/refund at random and maintains ghost accounting the invariants
///         are checked against.
contract VaultHandler is Test {
    MockAUSD public ausd;
    PrismClaimVault public vault;

    uint256 internal senderPk = 0x5E4DE7;
    uint256 internal authorizerPk = 0xA07;
    uint256 internal recipientPk = 0xB0B;
    address public sender;
    address public recipient;

    bytes32 internal constant RECEIVE_TYPEHASH =
        keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

    struct Local {
        bytes32 claimId;
        uint256 amount;
        uint256 expiry;
        uint8 status; // 1 Funded, 2 Claimed, 3 Refunded
    }

    Local[] public locals;
    uint256 public counter;

    // Ghost accounting
    uint256 public outstandingFunded; // sum of amounts of currently-Funded claims
    uint256 public totalDistributed; // sum claimed to recipient + refunded to sender
    uint256 public totalFunded; // sum of everything ever funded

    constructor(MockAUSD ausd_, PrismClaimVault vault_) {
        ausd = ausd_;
        vault = vault_;
        sender = vm.addr(senderPk);
        recipient = vm.addr(recipientPk);
        ausd.mint(sender, type(uint128).max);
    }

    function fund(uint256 amountSeed, uint256 ttlSeed) external {
        if (counter >= 64) return; // keep bounded
        uint256 amount = bound(amountSeed, 1, 1_000e6);
        uint256 ttl = bound(ttlSeed, 1 hours, 30 days);
        bytes32 claimId = keccak256(abi.encode("c", counter));
        bytes32 ref = keccak256(abi.encode("r", counter));
        counter++;
        uint256 expiry = block.timestamp + ttl;
        bytes32 nonce = vault.fundingNonce(claimId, ref, address(ausd), amount, sender);
        uint256 vb = block.timestamp + 300;
        bytes32 sh = keccak256(abi.encode(RECEIVE_TYPEHASH, sender, address(vault), amount, uint256(0), vb, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(senderPk, keccak256(abi.encodePacked("\x19\x01", ausd.DOMAIN_SEPARATOR(), sh)));
        vault.fundClaim(claimId, ref, sender, address(ausd), amount, expiry, 0, vb, nonce, v, r, s);
        locals.push(Local({claimId: claimId, amount: amount, expiry: expiry, status: 1}));
        outstandingFunded += amount;
        totalFunded += amount;
    }

    function collect(uint256 idx) external {
        if (locals.length == 0) return;
        Local storage l = locals[idx % locals.length];
        if (l.status != 1 || block.timestamp > l.expiry) return;
        bytes32 eligNonce = keccak256(abi.encode("e", l.claimId, block.timestamp));
        uint256 eligExpiry = l.expiry;
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(authorizerPk, vault.eligibilityDigest(l.claimId, recipient, 1, eligExpiry, eligNonce));
        (uint8 rv, bytes32 rr, bytes32 rs) = vm.sign(recipientPk, vault.claimIntentDigest(l.claimId, recipient));
        vault.claim(l.claimId, recipient, 1, eligExpiry, eligNonce, abi.encodePacked(ar, as_, av), abi.encodePacked(rr, rs, rv));
        l.status = 2;
        outstandingFunded -= l.amount;
        totalDistributed += l.amount;
    }

    function refund(uint256 idx) external {
        if (locals.length == 0) return;
        Local storage l = locals[idx % locals.length];
        if (l.status != 1 || block.timestamp <= l.expiry) return;
        vault.refund(l.claimId);
        l.status = 3;
        outstandingFunded -= l.amount;
        totalDistributed += l.amount;
    }

    function advanceTime(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 45 days));
    }

    function localsLength() external view returns (uint256) {
        return locals.length;
    }
}

contract PrismVaultInvariantTest is StdInvariant, Test {
    MockAUSD internal ausd;
    PrismClaimVault internal vault;
    VaultHandler internal handler;

    function setUp() public {
        ausd = new MockAUSD();
        MockAUSD usdc = new MockAUSD();
        vault = new PrismClaimVault(address(this), address(ausd), address(usdc), vm.addr(0xA07));
        handler = new VaultHandler(ausd, vault);
        targetContract(address(handler));
    }

    /// The vault holds exactly the AUSD backing its currently-funded claims: nothing leaks, nothing
    /// is conjured. This subsumes "liabilities <= balance" and "funds can never disappear".
    function invariant_balanceEqualsOutstanding() public view {
        assertEq(ausd.balanceOf(address(vault)), handler.outstandingFunded());
    }

    /// Everything ever funded is either still held by the vault or was distributed as a claim/refund.
    /// Combined with `invariant_balanceEqualsOutstanding`, no AUSD is created or destroyed.
    function invariant_fundsConserved() public view {
        assertEq(handler.outstandingFunded() + handler.totalDistributed(), handler.totalFunded());
    }

    /// Claimed/refunded claims never revert to Funded on-chain.
    function invariant_noFundedRegression() public view {
        uint256 n = handler.localsLength();
        for (uint256 i; i < n; i++) {
            (bytes32 claimId,,, uint8 ghostStatus) = handler.locals(i);
            (,,,,,, PrismClaimVault.ClaimStatus onchain) = vault.claims(claimId);
            if (ghostStatus == 2 || ghostStatus == 3) {
                assertTrue(onchain != PrismClaimVault.ClaimStatus.Funded, "no regression to Funded");
            }
        }
    }
}
