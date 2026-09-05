// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {PrismPaymentRouter} from "../src/PrismPaymentRouter.sol";
import {PrismClaimVault} from "../src/PrismClaimVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice On-chain privacy invariants (FORGE MUT-01 / MUT-02).
///
/// Prism's central privacy claim is that a phone number is never an on-chain identifier. These
/// tests settle a real payment and fund/collect a real claim, then scan every byte the chain can
/// see — calldata, event topics, event data, and every written storage slot — for the phone
/// number and for every value derivable from it by an attacker who can guess a number
/// (`keccak256(phone)`, `sha256(phone)`, the raw ASCII, and the E.164 digits as an integer).
///
/// The scan is the point: it does not assert that a specific field is clean, it asserts that the
/// phone is absent from the entire observable surface, so a future field that carries a
/// phone-derived value fails this suite.
contract PrismPrivacyTest is Test {
    MockUSDC internal usdc;
    PrismPaymentRouter internal router;
    PrismClaimVault internal vault;

    uint256 internal payerPk = 0xA11CE;
    uint256 internal recipientPk = 0xB0B0;
    uint256 internal authorizerPk = 0xA07;
    address internal payer;
    address internal recipient;
    address internal relayer = address(0xF00D);

    string internal constant PHONE = "+2348031234567";

    bytes32 internal constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// Every value an attacker could precompute from a guessed phone number.
    function _forbidden() internal pure returns (bytes32[] memory out) {
        out = new bytes32[](4);
        out[0] = keccak256(bytes(PHONE)); // keccak of the E.164 string
        out[1] = sha256(bytes(PHONE)); // MUT-02: SHA256(phone)
        out[2] = keccak256(abi.encodePacked(uint256(2348031234567))); // digits as a number
        out[3] = bytes32(uint256(2348031234567)); // the number itself, right-aligned
    }

    function setUp() public {
        usdc = new MockUSDC();
        router = new PrismPaymentRouter(address(usdc));
        payer = vm.addr(payerPk);
        recipient = vm.addr(recipientPk);
        vault = new PrismClaimVault(address(this), address(usdc), vm.addr(authorizerPk));
        usdc.mint(payer, 1_000e6);
        vm.warp(1_800_000_000);
    }

    // --- scanners ------------------------------------------------------------

    function _assertNoPhone(bytes memory blob, string memory where) internal pure {
        bytes32[] memory bad = _forbidden();
        // Raw ASCII of the phone number must not appear anywhere in the blob.
        require(!_contains(blob, bytes(PHONE)), string.concat("raw phone in ", where));
        for (uint256 i = 0; i < bad.length; i++) {
            require(!_contains(blob, abi.encodePacked(bad[i])), string.concat("phone-derived value in ", where));
        }
    }

    function _contains(bytes memory haystack, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0 || haystack.length < needle.length) return false;
        for (uint256 i = 0; i <= haystack.length - needle.length; i++) {
            bool hit = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }

    function _scanLogs(string memory where) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length > 0, string.concat("no events emitted for ", where));
        for (uint256 i = 0; i < logs.length; i++) {
            for (uint256 t = 0; t < logs[i].topics.length; t++) {
                _assertNoPhone(abi.encodePacked(logs[i].topics[t]), string.concat(where, " event topic"));
            }
            _assertNoPhone(logs[i].data, string.concat(where, " event data"));
        }
    }

    function _scanStorage(address target, string memory where) internal {
        (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(target);
        for (uint256 i = 0; i < writes.length; i++) {
            _assertNoPhone(abi.encodePacked(writes[i]), string.concat(where, " storage slot key"));
            _assertNoPhone(abi.encodePacked(vm.load(target, writes[i])), string.concat(where, " storage slot value"));
        }
        for (uint256 i = 0; i < reads.length; i++) {
            _assertNoPhone(abi.encodePacked(reads[i]), string.concat(where, " storage slot read"));
        }
    }

    // --- MUT-01: a direct payment leaks no phone -----------------------------

    function testDirectPaymentEmitsNoPhoneDerivedValue() public {
        PrismPaymentRouter.PaymentEnvelope memory env = PrismPaymentRouter.PaymentEnvelope({
            paymentId: keccak256("payment-1"),
            payer: payer,
            recipient: recipient,
            amount: 20e6,
            requestId: bytes32(0),
            // Opaque: derived from Prism identity data, never from the alias the user typed.
            resolutionHash: keccak256(abi.encode("prism-identity", uint256(1), keccak256("res-request"))),
            validBefore: block.timestamp + 300,
            nonce: keccak256("nonce-1")
        });
        (uint8 v, bytes32 r, bytes32 s) = _signUsdc(env);
        bytes memory prismSig = _signEnvelope(env);

        // The calldata a relayer broadcasts is public forever — scan it before it is sent.
        bytes memory calldataBlob = abi.encodeCall(PrismPaymentRouter.settle, (env, prismSig, v, r, s));
        _assertNoPhone(calldataBlob, "settle calldata");

        vm.recordLogs();
        vm.record();
        vm.prank(relayer);
        router.settle(env, prismSig, v, r, s);

        _scanLogs("settle");
        _scanStorage(address(router), "router");
        _scanStorage(address(usdc), "usdc");
        assertEq(usdc.balanceOf(recipient), 20e6, "payment did not actually settle");
    }

    // --- MUT-01/MUT-02: a pre-user claim leaks no phone ----------------------

    function testClaimLifecycleEmitsNoPhoneDerivedValue() public {
        bytes32 claimId = keccak256("claim-1");
        // recipientReference is random in production; it must never be a function of the phone.
        bytes32 recipientReference = keccak256("random-reference-1");
        uint256 amount = 20e6;
        uint256 expiry = block.timestamp + 7 days;
        uint256 validBefore = block.timestamp + 300;
        bytes32 nonce = vault.fundingNonce(claimId, recipientReference, amount, payer);

        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, payer, address(vault), amount, uint256(0), validBefore, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));

        bytes memory fundCalldata = abi.encodeCall(
            PrismClaimVault.fundClaim,
            (claimId, recipientReference, payer, amount, expiry, 0, validBefore, nonce, v, r, s)
        );
        _assertNoPhone(fundCalldata, "fundClaim calldata");

        vm.recordLogs();
        vm.record();
        vm.prank(relayer);
        vault.fundClaim(claimId, recipientReference, payer, amount, expiry, 0, validBefore, nonce, v, r, s);
        _scanLogs("fundClaim");
        _scanStorage(address(vault), "vault");

        // Collection carries the recipient's alias eligibility — the most likely place to leak.
        uint256 eligExpiry = block.timestamp + 300;
        bytes32 eligNonce = keccak256("elig-nonce-1");
        (uint8 av, bytes32 ar, bytes32 as_) =
            vm.sign(authorizerPk, vault.eligibilityDigest(claimId, recipient, 1, eligExpiry, eligNonce));
        (uint8 rv, bytes32 rr, bytes32 rs) = vm.sign(recipientPk, vault.claimIntentDigest(claimId, recipient));

        bytes memory claimCalldata = abi.encodeCall(
            PrismClaimVault.claim,
            (claimId, recipient, 1, eligExpiry, eligNonce, abi.encodePacked(ar, as_, av), abi.encodePacked(rr, rs, rv))
        );
        _assertNoPhone(claimCalldata, "claim calldata");

        vm.recordLogs();
        vm.record();
        vm.prank(relayer);
        vault.claim(
            claimId, recipient, 1, eligExpiry, eligNonce, abi.encodePacked(ar, as_, av), abi.encodePacked(rr, rs, rv)
        );
        _scanLogs("claim");
        _scanStorage(address(vault), "vault after claim");
        assertEq(usdc.balanceOf(recipient), amount, "claim did not actually pay out");
    }

    // --- the scanner must be able to fail ------------------------------------

    /// @notice Guards the guard: a blob that DOES carry SHA256(phone) must be rejected. Without
    ///         this, a broken scanner would silently pass every privacy test above.
    function testScannerDetectsPhoneDerivedValue() public {
        bytes memory leaky = abi.encode(uint256(1), sha256(bytes(PHONE)), address(this));
        vm.expectRevert(bytes("phone-derived value in synthetic blob"));
        this.exposedAssertNoPhone(leaky, "synthetic blob");

        bytes memory rawLeak = abi.encodePacked(uint256(7), bytes(PHONE));
        vm.expectRevert(bytes("raw phone in synthetic blob"));
        this.exposedAssertNoPhone(rawLeak, "synthetic blob");
    }

    function exposedAssertNoPhone(bytes memory blob, string memory where) external pure {
        _assertNoPhone(blob, where);
    }

    // --- helpers -------------------------------------------------------------

    function _signEnvelope(PrismPaymentRouter.PaymentEnvelope memory env) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPk, router.envelopeDigest(env));
        return abi.encodePacked(r, s, v);
    }

    function _signUsdc(PrismPaymentRouter.PaymentEnvelope memory env)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_TYPEHASH, env.payer, env.recipient, env.amount, uint256(0), env.validBefore, env.nonce)
        );
        (v, r, s) = vm.sign(payerPk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }
}
