// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ISafe, ISafeProxyFactory, SafeOperation} from "../../src/circles/interfaces/ISafe.sol";
import {PrismP256SafeOwner} from "../../src/circles/PrismP256SafeOwner.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";

/// @notice Phase 3 of the Prism Circles proof: the execution and gas model.
///
///         Two properties are established against a real Safe v1.4.1 on a Monad testnet fork:
///
///         1. ZERO-MON MEMBERS. No Circle member, and not the Circle Safe itself, needs to hold a
///            single wei of MON for a Circle payment to settle. A Prism relayer broadcasts.
///
///         2. THE RELAYER IS A COURIER, NOT A PARTY. Once admins have signed, the relayer cannot
///            change the recipient, the amount, the asset, the nonce, the operation, or any byte
///            of calldata — and it cannot quietly pay itself through Safe's gas-refund fields.
contract CircleRelayerModelTest is Test {
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    address internal constant USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;

    ISafeProxyFactory internal factory = ISafeProxyFactory(SAFE_PROXY_FACTORY);

    uint256 internal meraPk = 0xA11CE;
    address internal meraOwner;
    PrismP256SafeOwner internal p256Owner;

    address internal recipient = makeAddr("tobi");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        vm.createSelectFork(_rpc());
        meraOwner = vm.addr(meraPk);
        (uint256 qx, uint256 qy) = _pubkey(0);
        p256Owner = new PrismP256SafeOwner(qx, qy);
    }

    function _rpc() internal view returns (string memory) {
        try vm.envString("MONAD_TESTNET_RPC_URL") returns (string memory url) {
            return url;
        } catch {
            return "https://testnet-rpc.monad.xyz";
        }
    }

    function _pubkey(uint256 i) internal returns (uint256 x, uint256 y) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = "script/circles/p256-sign.mjs";
        cmd[2] = "pubkey";
        cmd[3] = vm.toString(i);
        (x, y) = abi.decode(vm.ffi(cmd), (uint256, uint256));
    }

    function _signP256(uint256 i, bytes32 h) internal returns (bytes memory) {
        string[] memory cmd = new string[](5);
        cmd[0] = "node";
        cmd[1] = "script/circles/p256-sign.mjs";
        cmd[2] = "sign";
        cmd[3] = vm.toString(i);
        cmd[4] = vm.toString(h);
        return vm.ffi(cmd);
    }

    function _circle(address owner, uint256 salt) internal returns (ISafe safe) {
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory init = abi.encodeCall(
            ISafe.setup,
            (owners, 1, address(0), "", SAFE_FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );
        safe = ISafe(factory.createProxyWithNonce(SAFE_SINGLETON, init, salt));
        deal(USDC, address(safe), 100e6);
    }

    function _envelope(address owner, bytes memory sig) internal pure returns (bytes memory) {
        return abi.encodePacked(
            bytes32(uint256(uint160(owner))), bytes32(uint256(65)), uint8(0), uint256(sig.length), sig
        );
    }

    struct Tx {
        address to;
        uint256 value;
        bytes data;
        SafeOperation op;
        uint256 safeTxGas;
        uint256 baseGas;
        uint256 gasPrice;
        address gasToken;
        address payable refundReceiver;
        uint256 nonce;
    }

    function _pay(ISafe safe, address who, uint256 amount) internal view returns (Tx memory t) {
        t.to = USDC;
        t.data = abi.encodeCall(IERC20.transfer, (who, amount));
        t.op = SafeOperation.Call;
        t.refundReceiver = payable(address(0));
        t.nonce = safe.nonce();
    }

    function _hash(ISafe safe, Tx memory t) internal view returns (bytes32) {
        return safe.getTransactionHash(
            t.to, t.value, t.data, t.op, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, t.nonce
        );
    }

    function _exec(ISafe safe, Tx memory t, bytes memory sigs) internal returns (bool) {
        return safe.execTransaction(
            t.to, t.value, t.data, t.op, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, sigs
        );
    }

    // ==========================================================================================
    // 1. Zero-MON members
    // ==========================================================================================

    function test_CircleSettlesWithEveryMemberHoldingZeroMon() public {
        ISafe safe = _circle(address(p256Owner), 700);
        address relayer = makeAddr("prism-relayer");
        vm.deal(relayer, 1 ether); // only the relayer is funded with MON

        // Forked addresses can carry real testnet balances, so the zero-MON condition is set
        // explicitly rather than assumed — this is the scenario being claimed, not an accident.
        vm.deal(address(p256Owner), 0);
        vm.deal(meraOwner, 0);
        vm.deal(address(safe), 0);
        assertEq(address(p256Owner).balance, 0, "member must hold no MON");
        assertEq(meraOwner.balance, 0, "member must hold no MON");
        assertEq(address(safe).balance, 0, "the Circle Safe itself must hold no MON");

        Tx memory t = _pay(safe, recipient, 20e6);
        bytes memory sig = _signP256(0, _hash(safe, t));

        vm.prank(relayer);
        assertTrue(_exec(safe, t, _envelope(address(p256Owner), sig)));

        assertEq(IERC20(USDC).balanceOf(recipient), 20e6, "payment did not settle");
        // Nothing drew native currency out of the Circle or its members.
        assertEq(address(safe).balance, 0, "Safe spent MON");
        assertEq(address(p256Owner).balance, 0, "member spent MON");
    }

    /// @dev The relayer is interchangeable: the same signed transaction is valid from any sender,
    ///      which is what makes the relayer a courier rather than a privileged party.
    function test_AnyRelayerCanBroadcastTheSameSignedTransaction() public {
        ISafe safe = _circle(address(p256Owner), 701);
        Tx memory t = _pay(safe, recipient, 20e6);
        bytes memory envelope = _envelope(address(p256Owner), _signP256(0, _hash(safe, t)));

        // Even an address Prism has never seen can deliver it. Authority is in the signature.
        vm.prank(makeAddr("some-random-stranger"));
        assertTrue(_exec(safe, t, envelope));
        assertEq(IERC20(USDC).balanceOf(recipient), 20e6);
    }

    // ==========================================================================================
    // 2. The relayer cannot alter what was signed
    // ==========================================================================================

    /// @dev One reviewed payment, then every field a hostile relayer might reach for. Each
    ///      mutation is rejected by the Safe with GS024 before any USDC moves.
    function test_RelayerCannotAlterAnySignedField() public {
        ISafe safe = _circle(address(p256Owner), 702);
        address relayer = makeAddr("hostile-relayer");

        Tx memory reviewed = _pay(safe, recipient, 20e6);
        bytes memory sig = _signP256(0, _hash(safe, reviewed));
        bytes memory envelope = _envelope(address(p256Owner), sig);

        // NOTE: `Tx memory m = reviewed` would alias the same memory and quietly corrupt the
        // baseline, so every mutation starts from an explicit deep copy.
        Tx memory m;

        m = _copy(reviewed); m.data = abi.encodeCall(IERC20.transfer, (attacker, 20e6));
        _expectRejected(safe, m, envelope, relayer, "recipient");

        m = _copy(reviewed); m.data = abi.encodeCall(IERC20.transfer, (recipient, 100e6));
        _expectRejected(safe, m, envelope, relayer, "amount");

        m = _copy(reviewed); m.to = attacker;
        _expectRejected(safe, m, envelope, relayer, "asset target");

        m = _copy(reviewed); m.op = SafeOperation.DelegateCall;
        _expectRejected(safe, m, envelope, relayer, "operation");

        m = _copy(reviewed); m.value = 1;
        _expectRejected(safe, m, envelope, relayer, "native value");

        m = _copy(reviewed);
        m.data = abi.encodeWithSignature("approve(address,uint256)", attacker, type(uint256).max);
        _expectRejected(safe, m, envelope, relayer, "calldata");

        // The nonce is deliberately absent from this list: `execTransaction` takes no nonce
        // argument at all. The Safe supplies its own and increments it on success, so a relayer
        // cannot select one — a stronger guarantee than rejecting a tampered value. Signing
        // against the wrong nonce is covered by CircleSafeOwnerCompat.test_E_WrongSafeNonce_Fails.
        assertEq(safe.nonce(), reviewed.nonce, "a rejected attempt consumed the nonce");

        // Nothing above moved a cent, and the reviewed payment is still executable.
        assertEq(IERC20(USDC).balanceOf(attacker), 0, "attacker was paid");
        vm.prank(relayer);
        assertTrue(_exec(safe, reviewed, envelope), "the honest transaction stopped working");
        assertEq(IERC20(USDC).balanceOf(recipient), 20e6);
    }

    /// @dev Safe's gas-refund fields are a second payment channel out of Circle funds. A relayer
    ///      that inflates them after signing is refused, because they are inside the digest.
    function test_RelayerCannotInsertAGasRefundToItself() public {
        ISafe safe = _circle(address(p256Owner), 703);
        address relayer = makeAddr("greedy-relayer");
        deal(USDC, address(safe), 100e6);

        Tx memory reviewed = _pay(safe, recipient, 20e6); // gasPrice 0, refundReceiver 0
        bytes memory envelope = _envelope(address(p256Owner), _signP256(0, _hash(safe, reviewed)));

        Tx memory grabby = _copy(reviewed);
        grabby.gasPrice = 1e9;
        grabby.baseGas = 100_000;
        grabby.gasToken = USDC;
        grabby.refundReceiver = payable(relayer);
        _expectRejected(safe, grabby, envelope, relayer, "gas refund");

        assertEq(IERC20(USDC).balanceOf(relayer), 0, "relayer refunded itself");
    }

    /// @dev Solidity assigns memory structs by reference; this produces an independent value so a
    ///      tampering case cannot mutate the reviewed transaction it is being compared against.
    function _copy(Tx memory t) internal pure returns (Tx memory c) {
        c = Tx(t.to, t.value, bytes.concat(t.data), t.op, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, t.nonce);
    }

    function _expectRejected(
        ISafe safe,
        Tx memory t,
        bytes memory envelope,
        address relayer,
        string memory what
    ) internal {
        uint256 before = IERC20(USDC).balanceOf(address(safe));
        vm.prank(relayer);
        vm.expectRevert("GS024");
        _exec(safe, t, envelope);
        assertEq(IERC20(USDC).balanceOf(address(safe)), before, string.concat("balance moved on tampered ", what));
    }
}
