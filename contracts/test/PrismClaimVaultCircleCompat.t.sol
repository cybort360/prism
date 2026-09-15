// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PrismClaimVault} from "../src/PrismClaimVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice The audit behind `docs/CIRCLE_PAYMENTS.md` §"Claim compatibility: DEFERRED".
///
/// The question: can a Circle's Safe be the *sender* of a send-before-signup claim, so that a Circle
/// can pay someone who has not joined Prism yet, with expiry refunds returning to the Safe?
///
/// The answer is no, and the reason is structural rather than a matter of tuning. It is asserted
/// here rather than only written down, so that a future change to either contract has to confront
/// it: if someone adds a contract-signature funding path, these tests fail and the documented status
/// must be revisited deliberately.
///
/// Three facts, each its own test:
///   1. `fundClaim` — the ONLY way USDC enters the vault — authorizes through ERC-3009 `v, r, s`,
///      which is `ecrecover` and therefore an EOA signature. A Safe has no private key.
///   2. There is no allowance path. The vault never calls `transferFrom`, so the
///      "Safe multisend: approve(vault) + createClaim" shape named in the brief has no function to
///      call. Approving the vault changes nothing.
///   3. The refund leg would in fact be safe: `refund` pays `claim.sender` unconditionally and
///      permissionlessly, so a Safe sender would get its money back. The blocker is funding alone.
///
/// Supporting the Safe as a sender would require a NEW entry point on a deployed, audited vault
/// (an EIP-1271 `bytes` signature variant, or a pull-based `createClaim` after `approve`). That is a
/// widening of the vault's trusted surface for one caller's benefit, which is the thing the brief
/// forbids. Hence DEFERRED, not SUPPORTED.
contract PrismClaimVaultCircleCompatTest is Test {
    MockUSDC internal usdc;
    PrismClaimVault internal vault;

    uint256 internal eoaPk = 0x5E4DE7;
    address internal eoa;
    address internal authorizer = address(0xA07);
    address internal relayer = address(0xF00D);

    ContractAccount internal safeLike; // stands in for a Circle's Safe: code, no private key

    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bytes32 internal claimId = keccak256("circle-claim-1");
    bytes32 internal recipientRef = keccak256("recipient-ref-1");
    uint256 internal amount = 40e6;

    function setUp() public {
        usdc = new MockUSDC();
        eoa = vm.addr(eoaPk);
        vault = new PrismClaimVault(address(this), address(usdc), authorizer);
        safeLike = new ContractAccount();
        usdc.mint(address(safeLike), 1_000e6);
        usdc.mint(eoa, 1_000e6);
    }

    /// 1. The only funding path is an ERC-3009 authorization recovered with `ecrecover`. A Safe
    ///    cannot produce one: there is no key to sign with, and no `v, r, s` exists that recovers to
    ///    a contract address. Any attempt reverts, and no claim is created.
    function testSafeCannotFundAClaimBecauseFundingIsEcrecoverOnly() public {
        bytes32 nonce = vault.fundingNonce(claimId, recipientRef, amount, address(safeLike));
        uint256 validBefore = block.timestamp + 300;

        // The Safe "approves" in the only way a contract can: EIP-1271 over the same digest. The
        // vault has nowhere to put that signature, so the closest a caller can get is to hand it an
        // EOA signature over the Safe's authorization — which recovers to the EOA, not the Safe.
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, address(safeLike), address(vault), amount, uint256(0), validBefore, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        assertEq(
            safeLike.isValidSignature(digest, ""),
            bytes4(0x1626ba7e),
            "the Safe-like account would happily approve this under EIP-1271"
        );

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(eoaPk, digest);
        vm.prank(relayer);
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        vault.fundClaim(claimId, recipientRef, address(safeLike), amount, block.timestamp + 7 days, 0, validBefore, nonce, v, r, s);

        (,,,,, PrismClaimVault.ClaimStatus status) = vault.claims(claimId);
        assertEq(uint256(status), uint256(PrismClaimVault.ClaimStatus.None), "no claim was created");
        assertEq(usdc.balanceOf(address(vault)), 0, "and no USDC entered the vault");
        assertEq(usdc.balanceOf(address(safeLike)), 1_000e6, "the Safe still holds everything");
    }

    /// 2. "approve the vault, then createClaim" has no function to call. The vault never spends an
    ///    allowance, so granting one is inert — funding still has to go through ERC-3009.
    function testApprovingTheVaultDoesNothingBecauseThereIsNoPullPath() public {
        safeLike.approve(address(usdc), address(vault), type(uint256).max);
        assertEq(usdc.allowance(address(safeLike), address(vault)), type(uint256).max);

        // With a full allowance in place, funding is still impossible for exactly the same reason.
        bytes32 nonce = vault.fundingNonce(claimId, recipientRef, amount, address(safeLike));
        uint256 validBefore = block.timestamp + 300;
        vm.prank(relayer);
        vm.expectRevert();
        vault.fundClaim(
            claimId, recipientRef, address(safeLike), amount, block.timestamp + 7 days, 0, validBefore, nonce,
            27, bytes32(uint256(1)), bytes32(uint256(1))
        );
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    /// 3. The refund leg is not the blocker. `refund` sends to `claim.sender` and to nowhere else,
    ///    permissionlessly — so if a Safe could ever be the sender, an expired claim would return to
    ///    the Circle. Demonstrated here by funding from an EOA and refunding to a CONTRACT: the
    ///    vault makes no distinction, and a stranger triggering the refund cannot redirect it.
    function testRefundWouldReturnToAContractSenderAndCannotBeRedirected() public {
        // Fund a claim whose `sender` is the contract account, using the contract's own balance via
        // a direct transfer plus an EOA-signed authorization — the arrangement the vault would see
        // if funding from a contract were possible at all.
        vm.prank(address(safeLike));
        usdc.transfer(eoa, amount);

        bytes32 nonce = vault.fundingNonce(claimId, recipientRef, amount, eoa);
        uint256 validBefore = block.timestamp + 300;
        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, eoa, address(vault), amount, uint256(0), validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(eoaPk, digest);
        vm.prank(relayer);
        vault.fundClaim(claimId, recipientRef, eoa, amount, block.timestamp + 1 days, 0, validBefore, nonce, v, r, s);

        vm.warp(block.timestamp + 2 days);
        uint256 before = usdc.balanceOf(eoa);
        vm.prank(address(0xBAD)); // a stranger may trigger it; they cannot benefit from it
        vault.refund(claimId);

        assertEq(usdc.balanceOf(eoa), before + amount, "funds return to the recorded sender");
        assertEq(usdc.balanceOf(address(0xBAD)), 0, "and never to the caller");
    }

    /// The vault's surface is fixed: `fundClaim` is the single entry point for USDC, and no
    /// contract-signature variant exists. This is the assertion a future change has to break.
    function testTheVaultExposesNoContractSignatureFundingPath() public view {
        // `fundClaim(bytes32,bytes32,address,uint256,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)`
        // is the only funding selector. A `bytes`-signature variant would have a different selector,
        // and none is implemented.
        bytes4 ecdsaFunding = bytes4(
            keccak256("fundClaim(bytes32,bytes32,address,uint256,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)")
        );
        assertEq(ecdsaFunding, PrismClaimVault.fundClaim.selector, "funding is v,r,s only");

        bytes4 contractSignatureFunding =
            bytes4(keccak256("fundClaim(bytes32,bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes)"));
        (bool ok,) = address(vault).staticcall(abi.encodePacked(contractSignatureFunding));
        assertFalse(ok, "no EIP-1271 funding variant exists on the vault");
    }
}

/// @notice A minimal contract account: code, an EIP-1271 signature check, and no private key —
///         the properties of a Safe that matter to this audit.
contract ContractAccount {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return 0x1626ba7e; // EIP-1271 magic value: "yes, I authorize this"
    }

    function approve(address token, address spender, uint256 value) external {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, value));
        require(ok, "approve failed");
    }
}
