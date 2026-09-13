// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {PrismP256Account} from "../src/PrismP256Account.sol";

/// @notice Does Safe's Allowance Module v1.0.0 support the way Prism members actually authorize
///         money, and can a delegate do anything with it beyond spending its allowance?
///
/// Everything here runs against **Safe's real deployed bytecode**. `canonical-runtime.hex` is the
/// runtime code read straight off `0x691f59471Bfd2B7d639DCF74671a2d648ED1E331`, byte-identical on
/// Optimism and Gnosis, and `vm.etch` puts that exact code under test. Nothing in this file is
/// exercising a recompilation, a mock, or a paraphrase of the module — a difference between what
/// Safe shipped and what Prism believes it shipped would surface here as a failing test.
///
/// The module has no constructor and no immutables (all its state is mappings), so etched runtime
/// code is behaviourally identical to a fresh deployment. That is also what makes the
/// "deploy the exact upstream runtime ourselves" option in `DeployAllowanceModuleV1.s.sol` sound.
///
/// The Safe is modelled rather than deployed: `SafeModuleHost` implements exactly the two entry
/// points the module calls and records every one of them. That is deliberate — the questions in
/// this file are about what the MODULE will do, and a recording host answers "what did the delegate
/// manage to make the Safe execute?" more precisely than a real Safe would.
contract AllowanceModuleCompatTest is Test {
    // --- the module under test ----------------------------------------------
    address internal constant MODULE = address(0xA11041A0CE);
    IAllowanceModule internal module;

    // --- cast ----------------------------------------------------------------
    SafeModuleHost internal safe;
    MockUSDC internal usdc;
    MockUSDC internal otherToken;

    uint256 internal sarahPk = 0x5A4A;
    address internal sarah;            // a member's Mera authority — an ordinary EOA
    address internal relayer = address(0xF00D);
    address internal merchant = address(0xBEEF);
    address internal attacker = address(0xBAD);

    uint96 internal constant DAILY = 100e6;   // $100/day
    uint16 internal constant ONE_DAY_MIN = 1440;

    function setUp() public {
        // Put Safe's actual deployed bytecode under test.
        string memory hexCode = vm.readFile("vendor/safe-allowances-v1.0.0/canonical-runtime.hex");
        vm.etch(MODULE, vm.parseBytes(hexCode));
        module = IAllowanceModule(MODULE);

        // A realistic chain age. The module computes `lastResetMin <= currentMin - resetTimeMin`,
        // and Solidity 0.7 arithmetic is unchecked — on a chain whose timestamp is smaller than the
        // reset window that subtraction underflows and every allowance reads as freshly reset.
        // Not reachable on a real network (Monad's timestamps are ~29M minutes), but it makes a
        // test that starts at t=1 silently vacuous.
        vm.warp(1_800_000_000);

        safe = new SafeModuleHost();
        usdc = new MockUSDC();
        otherToken = new MockUSDC();
        sarah = vm.addr(sarahPk);

        usdc.mint(address(safe), 10_000e6);
        otherToken.mint(address(safe), 10_000e6);

        // Enabling the module, registering a delegate and setting an allowance are all things only
        // the Safe itself can do — i.e. in Circles, threshold-approved Safe transactions.
        safe.enableModule(MODULE);
        safe.callModule(MODULE, abi.encodeCall(IAllowanceModule.addDelegate, (sarah)));
        safe.callModule(
            MODULE, abi.encodeCall(IAllowanceModule.setAllowance, (sarah, address(usdc), DAILY, ONE_DAY_MIN, 0))
        );
    }

    // =========================================================================
    // 1. Is this really the module we think it is?
    // =========================================================================

    function testTheEtchedCodeIsTheCanonicalV1Module() public view {
        assertEq(module.VERSION(), "1.0.0", "must be the release that fixed the replay bug");
        assertEq(module.NAME(), "Allowance Module");
        assertEq(
            keccak256(MODULE.code),
            0xfafc86ce3000fbdc8ad155875c0b3b5a20d17662e7c2cdbf3e95f15945a46657,
            "runtime must be byte-identical to the canonical deployment"
        );
    }

    // =========================================================================
    // 2. The execution model: can a Prism member actually authorize a spend?
    // =========================================================================

    /// THE SHIPPING PATH. A member's Circle authority is their existing Mera passkey-derived
    /// secp256k1 address — an ordinary EOA (CIRCLES_AUTHORITY_MODEL.md §2). They sign the module's
    /// EIP-712 transfer hash off-chain and a Prism relayer submits it, so the member spends no MON.
    function testRelayedEoaDelegateSignatureWorks() public {
        bytes32 transferHash = module.generateTransferHash(
            address(safe), address(usdc), merchant, 40e6, address(0), 0, 1
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sarahPk, transferHash);

        vm.prank(relayer); // the member sends nothing and holds MON = 0
        module.executeAllowanceTransfer(
            address(safe), address(usdc), payable(merchant), 40e6, address(0), 0, sarah, abi.encodePacked(r, s, v)
        );

        assertEq(usdc.balanceOf(merchant), 40e6, "the merchant was paid");
        assertEq(sarah.balance, 0, "the delegate never needed native gas");
        uint256[5] memory allowance = module.getTokenAllowance(address(safe), sarah, address(usdc));
        assertEq(allowance[1], 40e6, "spent tracked on-chain");
        assertEq(allowance[4], 2, "nonce advanced");
    }

    /// The direct-caller model: a CONTRACT delegate calls the module itself with an empty
    /// signature, and `recoverSignature` falls back to `msg.sender`. This is the path a
    /// PrismAccount-style contract authority would have to use, and it does work —
    /// `testAPrismP256AccountCannotReachTheModule` is why Prism cannot use it today.
    function testContractDelegateDirectCallWorks() public {
        ContractDelegate delegateContract = new ContractDelegate();
        safe.callModule(MODULE, abi.encodeCall(IAllowanceModule.addDelegate, (address(delegateContract))));
        safe.callModule(
            MODULE,
            abi.encodeCall(IAllowanceModule.setAllowance, (address(delegateContract), address(usdc), DAILY, ONE_DAY_MIN, 0))
        );

        // Empty signature => the module authenticates msg.sender, which IS the delegate.
        delegateContract.spend(MODULE, address(safe), address(usdc), payable(merchant), 25e6, "");
        assertEq(usdc.balanceOf(merchant), 25e6);

        // v == 1 is the same thing expressed in Safe's signature encoding, and also works.
        bytes memory vOneSignature = abi.encodePacked(bytes32(0), bytes32(0), uint8(1));
        delegateContract.spend(MODULE, address(safe), address(usdc), payable(merchant), 5e6, vOneSignature);
        assertEq(usdc.balanceOf(merchant), 30e6);
    }

    /// v1.0.0 REMOVED EIP-1271 support. v0.1.1 accepted contract signatures; the fixed release
    /// reverts on them outright. Any design that planned to have a smart-account authority sign an
    /// allowance transfer off-chain is incompatible with the only safe version of this module.
    function testEip1271ContractSignaturesAreRejectedOutright() public {
        ContractDelegate delegateContract = new ContractDelegate();
        safe.callModule(MODULE, abi.encodeCall(IAllowanceModule.addDelegate, (address(delegateContract))));
        safe.callModule(
            MODULE,
            abi.encodeCall(IAllowanceModule.setAllowance, (address(delegateContract), address(usdc), DAILY, ONE_DAY_MIN, 0))
        );

        // Safe's contract-signature encoding: v == 0, the signer address packed into r.
        bytes memory contractSignature =
            abi.encodePacked(bytes32(uint256(uint160(address(delegateContract)))), bytes32(uint256(65)), uint8(0));

        vm.prank(relayer);
        vm.expectRevert("Contract signatures are not supported by this module");
        module.executeAllowanceTransfer(
            address(safe), address(usdc), payable(merchant), 10e6, address(0), 0, address(delegateContract), contractSignature
        );
        assertEq(usdc.balanceOf(merchant), 0);
    }

    /// The other half of the incompatibility: Prism's P-256 smart account has no generic execute.
    /// It can only move its OWN token balance through `pay(...)`. So even though the module's
    /// msg.sender path would accept a contract delegate, a `PrismP256Account` cannot reach it.
    function testAPrismP256AccountCannotReachTheModule() public {
        // A real PrismP256Account, constructed with a valid P-256 public key.
        PrismP256Account account = new PrismP256Account(
            0x169c139ff5889d573327d25562a4aae488a874ca368e110bace208b4a22cc0ca,
            0x38cefadc3211b1dec8789b298d58e3985c4d09dc8e43a25e1c10cf5fa50539a9
        );

        // There is no `execute(address,uint256,bytes)` on it, so nothing can make it call the module.
        (bool ok,) = address(account).call(
            abi.encodeWithSignature(
                "execute(address,uint256,bytes)", MODULE, uint256(0), abi.encodeWithSignature("addDelegate(address)", sarah)
            )
        );
        assertFalse(ok, "PrismP256Account exposes no generic execute, so it cannot act as a delegate");
    }

    // =========================================================================
    // 3. Replay
    // =========================================================================

    function testTheSameTransferSignatureCannotBeReused() public {
        bytes32 transferHash =
            module.generateTransferHash(address(safe), address(usdc), merchant, 40e6, address(0), 0, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sarahPk, transferHash);
        bytes memory signature = abi.encodePacked(r, s, v);

        vm.prank(relayer);
        module.executeAllowanceTransfer(
            address(safe), address(usdc), payable(merchant), 40e6, address(0), 0, sarah, signature
        );

        // The nonce moved, so the same signature now recovers against a different hash.
        vm.prank(relayer);
        vm.expectRevert("expectedDelegate == signer && delegates[address(safe)][uint48(signer)].delegate == signer");
        module.executeAllowanceTransfer(
            address(safe), address(usdc), payable(merchant), 40e6, address(0), 0, sarah, signature
        );
        assertEq(usdc.balanceOf(merchant), 40e6, "paid exactly once");
    }

    /// The v1.0.0 fix itself, exercised directly.
    ///
    /// The nonce is a `uint16`. In v0.1.1 it wrapped, and a wrapped nonce makes every past
    /// signature valid again — that is the "delegate transfers could be replayed" bug. v1.0.0
    /// refuses to advance past `type(uint16).max` instead. Forcing the stored nonce to its maximum
    /// and watching the module refuse is a behavioural check that the deployed code is the FIXED
    /// one, independent of the bytecode comparison above.
    function testNonceExhaustionIsRefusedRatherThanWrapping() public {
        bytes32 slot = _allowanceSlot(address(safe), sarah, address(usdc));
        uint256 packed = uint256(vm.load(MODULE, slot));
        // Allowance packs as amount(96) | spent(96) | resetTimeMin(16) | lastResetMin(32) | nonce(16).
        packed = (packed & ~(uint256(0xffff) << 240)) | (uint256(type(uint16).max) << 240);
        vm.store(MODULE, slot, bytes32(packed));

        uint256[5] memory allowance = module.getTokenAllowance(address(safe), sarah, address(usdc));
        assertEq(allowance[4], type(uint16).max, "nonce is at the ceiling");

        vm.prank(relayer);
        vm.expectRevert("allowance.nonce != type(uint16).max (use different delegate)");
        module.executeAllowanceTransfer(
            address(safe), address(usdc), payable(merchant), 1e6, address(0), 0, sarah, ""
        );
    }

    // =========================================================================
    // 4. The limit is a limit
    // =========================================================================

    function testSpendingOverTheLimitFails() public {
        vm.prank(sarah);
        vm.expectRevert("newSpent > allowance.spent && newSpent <= allowance.amount");
        module.executeAllowanceTransfer(
            address(safe), address(usdc), payable(merchant), 140e6, address(0), 0, sarah, ""
        );
        assertEq(usdc.balanceOf(merchant), 0);
    }

    function testSpendingIsCumulativeWithinTheWindow() public {
        vm.prank(sarah);
        module.executeAllowanceTransfer(address(safe), address(usdc), payable(merchant), 60e6, address(0), 0, sarah, "");
        // $60 spent, $40 left: $50 must fail even though it is under the $100 headline limit.
        vm.prank(sarah);
        vm.expectRevert("newSpent > allowance.spent && newSpent <= allowance.amount");
        module.executeAllowanceTransfer(address(safe), address(usdc), payable(merchant), 50e6, address(0), 0, sarah, "");
        vm.prank(sarah);
        module.executeAllowanceTransfer(address(safe), address(usdc), payable(merchant), 40e6, address(0), 0, sarah, "");
        assertEq(usdc.balanceOf(merchant), 100e6);
    }

    /// The allowance resets on a schedule the CONTRACT keeps, not one Prism keeps. This is why
    /// "spent today" has to be read from `getTokenAllowance` rather than summed from activity.
    function testTheWindowRollsOverOnChain() public {
        vm.prank(sarah);
        module.executeAllowanceTransfer(address(safe), address(usdc), payable(merchant), 100e6, address(0), 0, sarah, "");
        uint256[5] memory before = module.getTokenAllowance(address(safe), sarah, address(usdc));
        assertEq(before[1], 100e6, "fully spent");

        vm.warp(block.timestamp + 1 days + 1);

        uint256[5] memory rolled = module.getTokenAllowance(address(safe), sarah, address(usdc));
        assertEq(rolled[1], 0, "the chain reset the window, with no transaction and nothing from Prism");

        vm.prank(sarah);
        module.executeAllowanceTransfer(address(safe), address(usdc), payable(merchant), 100e6, address(0), 0, sarah, "");
        assertEq(usdc.balanceOf(merchant), 200e6);
    }

    function testWrongTokenFails() public {
        // Sarah has an allowance for USDC and nothing else. A token with no allowance is amount 0.
        vm.prank(sarah);
        vm.expectRevert("newSpent > allowance.spent && newSpent <= allowance.amount");
        module.executeAllowanceTransfer(
            address(safe), address(otherToken), payable(merchant), 1e6, address(0), 0, sarah, ""
        );
        assertEq(otherToken.balanceOf(merchant), 0);
    }

    function testARemovedDelegateCannotSpend() public {
        // `removeAllowances: false` leaves the allowance figures in place, so what stops the spend
        // is unambiguously the delegate check rather than a zeroed limit.
        safe.callModule(MODULE, abi.encodeCall(IAllowanceModule.removeDelegate, (sarah, false)));

        vm.prank(sarah);
        vm.expectRevert("expectedDelegate == signer && delegates[address(safe)][uint48(signer)].delegate == signer");
        module.executeAllowanceTransfer(address(safe), address(usdc), payable(merchant), 1e6, address(0), 0, sarah, "");
        assertEq(usdc.balanceOf(merchant), 0);

        // A stale signature minted before the removal is equally dead.
        bytes32 transferHash =
            module.generateTransferHash(address(safe), address(usdc), merchant, 1e6, address(0), 0, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sarahPk, transferHash);
        vm.prank(relayer);
        vm.expectRevert("expectedDelegate == signer && delegates[address(safe)][uint48(signer)].delegate == signer");
        module.executeAllowanceTransfer(
            address(safe), address(usdc), payable(merchant), 1e6, address(0), 0, sarah, abi.encodePacked(r, s, v)
        );
    }

    /// Revoking with `removeAllowances: true` zeroes the figures as well, so the limit is gone even
    /// if the delegate were somehow re-added later. This is the shape Circles uses for "revoke".
    function testRevokingAlsoZeroesTheAllowanceFigures() public {
        safe.callModule(MODULE, abi.encodeCall(IAllowanceModule.removeDelegate, (sarah, true)));
        uint256[5] memory allowance = module.getTokenAllowance(address(safe), sarah, address(usdc));
        assertEq(allowance[0], 0, "amount zeroed");
        assertEq(allowance[1], 0, "spent zeroed");
        assertEq(allowance[2], 0, "reset window cleared");

        (address[] memory circleDelegates,) = module.getDelegates(address(safe), 0, 10);
        assertEq(circleDelegates.length, 0, "and the delegate is gone from the Circle's list");
    }

    /// A signature minted while the limit was $100 does not survive the limit being cut to $20.
    /// The Circle lowering an allowance takes effect immediately, without revoking anything.
    function testLoweringAnAllowanceInvalidatesAnInFlightSpend() public {
        bytes32 transferHash =
            module.generateTransferHash(address(safe), address(usdc), merchant, 80e6, address(0), 0, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sarahPk, transferHash);

        safe.callModule(
            MODULE, abi.encodeCall(IAllowanceModule.setAllowance, (sarah, address(usdc), 20e6, ONE_DAY_MIN, 0))
        );

        vm.prank(relayer);
        vm.expectRevert("newSpent > allowance.spent && newSpent <= allowance.amount");
        module.executeAllowanceTransfer(
            address(safe), address(usdc), payable(merchant), 80e6, address(0), 0, sarah, abi.encodePacked(r, s, v)
        );
        assertEq(usdc.balanceOf(merchant), 0);
    }

    function testDeletingAnAllowanceStopsSpendingImmediately() public {
        safe.callModule(MODULE, abi.encodeCall(IAllowanceModule.deleteAllowance, (sarah, address(usdc))));
        vm.prank(sarah);
        vm.expectRevert("newSpent > allowance.spent && newSpent <= allowance.amount");
        module.executeAllowanceTransfer(address(safe), address(usdc), payable(merchant), 1e6, address(0), 0, sarah, "");
    }

    // =========================================================================
    // 5. What a delegate CANNOT do
    // =========================================================================
    //
    // These four are one property looked at from four angles: the module's only outward call is a
    // fixed-shape ERC-20 `transfer(address,uint256)` (or a native send), built from arguments the
    // module itself assembles. A delegate never supplies calldata, so there is no request shape
    // that reaches the Safe as anything else.

    function testTheOnlyCallADelegateCanCauseIsAPlainTransfer() public {
        vm.prank(sarah);
        module.executeAllowanceTransfer(address(safe), address(usdc), payable(merchant), 10e6, address(0), 0, sarah, "");

        assertEq(safe.callCount(), 1);
        (address to, uint256 value, bytes memory data, uint8 operation) = safe.callAt(0);
        assertEq(to, address(usdc), "the Safe was told to call the token, not an arbitrary target");
        assertEq(value, 0);
        assertEq(operation, 0, "Call, never DelegateCall");
        assertEq(bytes4(data), bytes4(keccak256("transfer(address,uint256)")));
        assertEq(data.length, 68, "exactly a transfer, with no trailing calldata");
    }

    function testADelegateCannotMakeAnArbitrarySafeCall() public {
        // There is no entry point that takes calldata. The module's ABI has 19 functions and none
        // of them accepts a `to`+`data` pair from a delegate.
        (bool ok,) = MODULE.call(
            abi.encodeWithSignature(
                "execTransactionFromModule(address,uint256,bytes,uint8)", attacker, uint256(0), bytes(""), uint8(0)
            )
        );
        assertFalse(ok, "the module exposes no pass-through execution");
        assertEq(safe.callCount(), 0);
    }

    function testADelegateCannotChangeTheOwnerSet() public {
        // The only lever a delegate has is `token`, and it names the contract the Safe will call
        // `transfer(address,uint256)` on. Pointing it at the Safe cannot add an owner: the Safe has
        // no `transfer(address,uint256)`, and there is no allowance for it in any case.
        vm.prank(sarah);
        vm.expectRevert("newSpent > allowance.spent && newSpent <= allowance.amount");
        module.executeAllowanceTransfer(
            address(safe), address(safe), payable(attacker), 1e6, address(0), 0, sarah, ""
        );
        assertEq(safe.ownerAddedCount(), 0, "no owner was added");
    }

    function testADelegateCannotEnableAnotherModule() public {
        assertEq(safe.moduleCount(), 1, "only the allowance module is enabled");
        vm.prank(sarah);
        module.executeAllowanceTransfer(address(safe), address(usdc), payable(merchant), 1e6, address(0), 0, sarah, "");
        assertEq(safe.moduleCount(), 1, "spending cannot enable a module");

        // And `setAllowance` / `addDelegate` are Safe-only: the delegate calling them affects only
        // its OWN (empty) allowance book, never the Circle's.
        vm.prank(sarah);
        module.addDelegate(attacker);
        (address[] memory circleDelegates,) = module.getDelegates(address(safe), 0, 10);
        assertEq(circleDelegates.length, 1, "the Circle's delegate list is untouched");
        assertEq(circleDelegates[0], sarah);
    }

    function testADelegateCannotGrantAnUnlimitedTokenApproval() public {
        // `approve` never appears: the module builds `transfer(address,uint256)` and nothing else.
        vm.prank(sarah);
        module.executeAllowanceTransfer(address(safe), address(usdc), payable(attacker), 1e6, address(0), 0, sarah, "");
        assertEq(usdc.allowance(address(safe), attacker), 0, "no approval was created");
        assertEq(usdc.allowance(address(safe), sarah), 0);

        // And the spend itself was still bounded by the allowance.
        vm.prank(sarah);
        vm.expectRevert("newSpent > allowance.spent && newSpent <= allowance.amount");
        module.executeAllowanceTransfer(
            address(safe), address(usdc), payable(attacker), type(uint96).max, address(0), 0, sarah, ""
        );
    }

    /// A relayer cannot spend on a delegate's behalf. With an empty signature the module
    /// authenticates `msg.sender`, so a relayer submitting without the delegate's signature is
    /// simply not the delegate — which is what makes the relayed path safe to expose.
    function testARelayerCannotSpendWithoutTheDelegatesSignature() public {
        vm.prank(relayer);
        vm.expectRevert("expectedDelegate == signer && delegates[address(safe)][uint48(signer)].delegate == signer");
        module.executeAllowanceTransfer(
            address(safe), address(usdc), payable(merchant), 10e6, address(0), 0, sarah, ""
        );
        assertEq(usdc.balanceOf(merchant), 0);
    }

    /// The module can reimburse whoever submits the transaction, out of the SAME allowance, to
    /// `tx.origin`. Circles always sends `payment = 0` and sponsors gas from the relayer instead —
    /// this test records what the alternative would cost, so that choice is a decision rather than
    /// an oversight, and so a future change to it fails loudly here.
    function testRelayerPaymentWouldBeChargedToTheMembersAllowance() public {
        bytes32 transferHash =
            module.generateTransferHash(address(safe), address(usdc), merchant, 60e6, address(usdc), 30e6, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sarahPk, transferHash);

        vm.prank(relayer, relayer); // msg.sender AND tx.origin
        module.executeAllowanceTransfer(
            address(safe), address(usdc), payable(merchant), 60e6, address(usdc), 30e6, sarah, abi.encodePacked(r, s, v)
        );

        assertEq(usdc.balanceOf(merchant), 60e6, "the merchant got what was reviewed");
        assertEq(usdc.balanceOf(relayer), 30e6, "and the relayer took a fee from the Circle");
        uint256[5] memory allowance = module.getTokenAllowance(address(safe), sarah, address(usdc));
        assertEq(allowance[1], 90e6, "BOTH came out of the member's $100 limit");
    }

    // =========================================================================
    // 6. Cross-implementation vectors
    // =========================================================================

    /// Emit the module's own `generateTransferHash` answers for fixed inputs, so Prism's backend
    /// re-implementation can be held to the deployed contract rather than to itself. Same discipline
    /// as `proof/circles/safe-tx-vectors.json` for the Safe digest: the value a compromised backend
    /// would have to lie with is the one that must be checkable offline.
    function testWriteAllowanceTransferVectors() public {
        string memory out = "[";
        for (uint256 i = 0; i < 3; i++) {
            address to = [merchant, attacker, address(0xC0FFEE)][i];
            uint96 amount = [uint96(40e6), uint96(1), uint96(type(uint96).max)][i];
            uint16 nonce = [uint16(1), uint16(2), uint16(65534)][i];
            bytes32 h = module.generateTransferHash(address(safe), address(usdc), to, amount, address(0), 0, nonce);
            out = string.concat(
                out,
                i == 0 ? "" : ",",
                '{"chainId":', vm.toString(block.chainid),
                ',"module":"', vm.toString(MODULE),
                '","safe":"', vm.toString(address(safe)),
                '","token":"', vm.toString(address(usdc)),
                '","to":"', vm.toString(to),
                '","amount":"', vm.toString(uint256(amount)),
                '","nonce":', vm.toString(uint256(nonce)),
                ',"transferHash":"', vm.toString(h), '"}'
            );
        }
        out = string.concat(out, "]");
        vm.writeFile("../proof/circles/allowance-transfer-vectors.json", out);
        assertGt(bytes(out).length, 100);
    }

    // --- helpers -------------------------------------------------------------

    /// Storage slot of `allowances[safe][delegate][token]` (mapping at slot 0).
    function _allowanceSlot(address safe_, address delegate_, address token_) internal pure returns (bytes32) {
        bytes32 s1 = keccak256(abi.encode(safe_, uint256(0)));
        bytes32 s2 = keccak256(abi.encode(delegate_, s1));
        return keccak256(abi.encode(token_, s2));
    }
}

// =============================================================================
// Test doubles
// =============================================================================

interface IAllowanceModule {
    function NAME() external view returns (string memory);
    function VERSION() external view returns (string memory);
    function addDelegate(address delegate) external;
    function removeDelegate(address delegate, bool removeAllowances) external;
    function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)
        external;
    function deleteAllowance(address delegate, address token) external;
    function getTokenAllowance(address safe, address delegate, address token) external view returns (uint256[5] memory);
    function getDelegates(address safe, uint48 start, uint8 pageSize)
        external
        view
        returns (address[] memory results, uint48 next);
    function generateTransferHash(
        address safe,
        address token,
        address to,
        uint96 amount,
        address paymentToken,
        uint96 payment,
        uint16 nonce
    ) external view returns (bytes32);
    function executeAllowanceTransfer(
        address safe,
        address token,
        address payable to,
        uint96 amount,
        address paymentToken,
        uint96 payment,
        address delegate,
        bytes calldata signature
    ) external;
}

/// @notice The two entry points the Allowance Module calls on a Safe, plus a recorder.
/// @dev Only an enabled module may execute, which is the property that matters: everything the
///      delegate manages to cause passes through here and is visible to the test.
contract SafeModuleHost {
    struct ModuleCall {
        address to;
        uint256 value;
        bytes data;
        uint8 operation;
    }

    mapping(address => bool) public isModuleEnabled;
    ModuleCall[] internal calls;
    uint256 public moduleCount;
    uint256 public ownerAddedCount;

    receive() external payable {}

    function enableModule(address module) external {
        if (!isModuleEnabled[module]) {
            isModuleEnabled[module] = true;
            moduleCount++;
        }
    }

    /// Stands in for a threshold-approved Circle transaction: the Safe calling the module itself.
    function callModule(address module, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = module.call(data);
        require(ok, _revertReason(ret));
        return ret;
    }

    /// If a delegate ever managed to add an owner, this is where it would show up.
    function addOwnerWithThreshold(address, uint256) external {
        ownerAddedCount++;
    }

    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success)
    {
        require(isModuleEnabled[msg.sender], "not an enabled module");
        calls.push(ModuleCall(to, value, data, operation));
        (success,) = to.call{value: value}(data);
    }

    function execTransactionFromModuleReturnData(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success, bytes memory returnData)
    {
        require(isModuleEnabled[msg.sender], "not an enabled module");
        calls.push(ModuleCall(to, value, data, operation));
        (success, returnData) = to.call{value: value}(data);
    }

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function callAt(uint256 i) external view returns (address, uint256, bytes memory, uint8) {
        ModuleCall storage c = calls[i];
        return (c.to, c.value, c.data, c.operation);
    }

    function _revertReason(bytes memory ret) internal pure returns (string memory) {
        if (ret.length < 68) return "module call failed";
        assembly {
            ret := add(ret, 0x04)
        }
        return abi.decode(ret, (string));
    }
}

/// @notice A contract authority: it can call the module itself, and it answers EIP-1271.
contract ContractDelegate {
    function spend(
        address module,
        address safe,
        address token,
        address payable to,
        uint96 amount,
        bytes memory signature
    ) external {
        IAllowanceModule(module).executeAllowanceTransfer(safe, token, to, amount, address(0), 0, address(this), signature);
    }

    function isValidSignature(bytes memory, bytes memory) external pure returns (bytes4) {
        return 0x20c13b0b;
    }
}
