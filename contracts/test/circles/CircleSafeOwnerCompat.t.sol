// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ISafe, ISafeProxyFactory, SafeOperation} from "../../src/circles/interfaces/ISafe.sol";
import {PrismP256SafeOwner} from "../../src/circles/PrismP256SafeOwner.sol";
import {P256Verifier} from "prism-archive/libraries/P256Verifier.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";

/// @notice Reproduces the EIP-1271 surface of `archive/erc4337-p256/src/PrismAccount.sol`
///         exactly: only the `bytes32` overload, only `0x1626ba7e`.
/// @dev The archived file itself cannot be compiled (its `validateUserOp` reads
///      `userOp.signature.offset`, which Solidity does not allow for a calldata struct member),
///      so its 1271 behaviour is restated here verbatim in order to be tested against a real Safe.
contract ArchivedPrismAccount1271 {
    bytes4 internal constant ERC1271_MAGICVALUE = 0x1626ba7e;
    uint256 public immutable qx;
    uint256 public immutable qy;

    constructor(uint256 qx_, uint256 qy_) {
        qx = qx_;
        qy = qy_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 64) return 0xffffffff;
        uint256 r;
        uint256 s;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
        }
        bytes32 digest = sha256(abi.encodePacked(hash));
        return P256Verifier.verify(digest, r, s, qx, qy) ? ERC1271_MAGICVALUE : bytes4(0xffffffff);
    }
}

/// @notice Phase 1 of the Prism Circles architecture proof.
///
///         Runs against the REAL Safe v1.4.1 deployment on Monad testnet (fork) and the REAL
///         EIP-7951 P-256 precompile, using the REAL Circle USDC contract. Nothing here is mocked
///         except the Circle members' key material.
///
///         Requires: `--network monad` (enables Monad's precompile set) and `ffi = true`
///         (the P-256 signing oracle in `script/circles/p256-sign.mjs`).
contract CircleSafeOwnerCompatTest is Test {
    // Verified against @safe-global/safe-deployments and by on-chain codehash — see
    // docs/CIRCLES_DEPENDENCY_AUDIT.md.
    address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant SAFE_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    address internal constant USDC = 0x534b2f3A21130d7a60830c2Df862319e593943A3;
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10143;

    string internal constant SIGNER = "script/circles/p256-sign.mjs";

    ISafeProxyFactory internal factory = ISafeProxyFactory(SAFE_PROXY_FACTORY);

    // Circle member key material.
    uint256 internal meraPk = 0xA11CE; // stands in for a Mera passkey-derived secp256k1 account
    address internal meraOwner;
    PrismP256SafeOwner internal p256Owner; // P-256 authority, key index 0
    uint256 internal qx0;
    uint256 internal qy0;

    address internal relayer = makeAddr("prism-relayer");
    address internal recipient = makeAddr("tobi");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        vm.createSelectFork(_rpc());
        assertEq(block.chainid, MONAD_TESTNET_CHAIN_ID, "fork is not Monad testnet");

        meraOwner = vm.addr(meraPk);
        (qx0, qy0) = _pubkey(0);
        p256Owner = new PrismP256SafeOwner(qx0, qy0);
    }

    function _rpc() internal view returns (string memory) {
        try vm.envString("MONAD_TESTNET_RPC_URL") returns (string memory url) {
            return url;
        } catch {
            return "https://testnet-rpc.monad.xyz";
        }
    }

    // ---------------------------------------------------------------- P-256 signing oracle (ffi)

    function _pubkey(uint256 index) internal returns (uint256 x, uint256 y) {
        string[] memory cmd = new string[](4);
        cmd[0] = "node";
        cmd[1] = SIGNER;
        cmd[2] = "pubkey";
        cmd[3] = vm.toString(index);
        bytes memory out = vm.ffi(cmd);
        require(out.length == 64, "pubkey oracle returned wrong length");
        (x, y) = abi.decode(out, (uint256, uint256));
    }

    /// @dev Signs the raw 32-byte hash the way Prism iOS does: CryptoKit applies SHA-256 before
    ///      P-256 ECDSA, so the oracle signs `hash` with digest algorithm sha256.
    function _signP256(uint256 index, bytes32 hash) internal returns (bytes memory) {
        string[] memory cmd = new string[](5);
        cmd[0] = "node";
        cmd[1] = SIGNER;
        cmd[2] = "sign";
        cmd[3] = vm.toString(index);
        cmd[4] = vm.toString(hash);
        bytes memory sig = vm.ffi(cmd);
        require(sig.length == 64, "signing oracle returned wrong length");
        return sig;
    }

    // ------------------------------------------------------------------------ Safe construction

    function _createSafe(address[] memory owners, uint256 threshold, uint256 salt)
        internal
        returns (ISafe safe)
    {
        bytes memory initializer = abi.encodeCall(
            ISafe.setup,
            (owners, threshold, address(0), "", SAFE_FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );
        safe = ISafe(factory.createProxyWithNonce(SAFE_SINGLETON, initializer, salt));
    }

    /// @dev Safe requires owners sorted ascending inside the signature blob; sort here so the
    ///      tests describe Circle admins in human order and still produce a valid envelope.
    function _sorted(address a, address b) internal pure returns (address[] memory out) {
        out = new address[](2);
        (out[0], out[1]) = a < b ? (a, b) : (b, a);
    }

    // ------------------------------------------------------------- Safe signature envelope build

    /// @dev One EIP-1271 contract signature. Static part is 65 bytes:
    ///      r = owner address, s = offset to the dynamic part, v = 0.
    function _contractSigEnvelope(address owner, bytes memory sig) internal pure returns (bytes memory) {
        return abi.encodePacked(
            bytes32(uint256(uint160(owner))), // r
            bytes32(uint256(65)), // s: dynamic part begins right after the single static slot
            uint8(0), // v = 0 marks a contract signature
            uint256(sig.length),
            sig
        );
    }

    /// @dev One ECDSA owner plus one contract owner, ordered by address as Safe demands.
    function _mixedEnvelope(
        address ecdsaOwner,
        bytes memory ecdsaSig,
        address contractOwner,
        bytes memory contractSig
    ) internal pure returns (bytes memory) {
        bytes memory contractStatic =
            abi.encodePacked(bytes32(uint256(uint160(contractOwner))), bytes32(uint256(130)), uint8(0));
        bytes memory dynamicPart = abi.encodePacked(uint256(contractSig.length), contractSig);
        return ecdsaOwner < contractOwner
            ? abi.encodePacked(ecdsaSig, contractStatic, dynamicPart)
            : abi.encodePacked(contractStatic, ecdsaSig, dynamicPart);
    }

    // ------------------------------------------------------------------------------ Circle spend

    struct Spend {
        address to;
        uint256 value;
        bytes data;
        SafeOperation operation;
        uint256 nonce;
    }

    function _usdcSpend(ISafe safe, address who, uint256 amount) internal view returns (Spend memory s) {
        s.to = USDC;
        s.value = 0;
        s.data = abi.encodeCall(IERC20.transfer, (who, amount));
        s.operation = SafeOperation.Call;
        s.nonce = safe.nonce();
    }

    function _hash(ISafe safe, Spend memory s) internal view returns (bytes32) {
        return safe.getTransactionHash(
            s.to, s.value, s.data, s.operation, 0, 0, 0, address(0), address(0), s.nonce
        );
    }

    function _exec(ISafe safe, Spend memory s, bytes memory signatures) internal returns (bool) {
        return safe.execTransaction(
            s.to, s.value, s.data, s.operation, 0, 0, 0, address(0), payable(address(0)), signatures
        );
    }

    function _fundUsdc(address who, uint256 amount) internal {
        deal(USDC, who, amount);
        assertEq(IERC20(USDC).balanceOf(who), amount, "USDC funding failed");
    }

    // ==========================================================================================
    // A. The dependency we are standing on is the real, canonical Safe.
    // ==========================================================================================

    function test_A_SafeDeploymentOnMonadIsCanonicalV141() public view {
        assertEq(ISafe(SAFE_SINGLETON).VERSION(), "1.4.1", "singleton is not Safe 1.4.1");
        // Codehashes published by @safe-global/safe-deployments for the canonical 1.4.1 release.
        assertEq(
            SAFE_SINGLETON.codehash,
            0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4,
            "Safe singleton codehash drifted from the canonical release"
        );
        assertEq(
            SAFE_PROXY_FACTORY.codehash,
            0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317,
            "SafeProxyFactory codehash drifted"
        );
        assertEq(
            SAFE_FALLBACK_HANDLER.codehash,
            0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9,
            "CompatibilityFallbackHandler codehash drifted"
        );
    }

    function test_A_MonadP256PrecompileIsLive() public view {
        // A signature this suite did not produce, from the archived live-precompile fixture.
        assertTrue(
            P256Verifier.verify(
                0x19c7a5c016ecf09862d33a4bd8eb4a95ab22acb6446e38159946ad7e08b42305,
                0xed3485d78b6a00b8b5785210de5b05033e2d5fccbe1653189b0c9110d4b06c95,
                0xcf5fd1ea40db4ccc0f1d80addad5be00d2177c42ecf2060f4074a635bc379717,
                0x7a0d5f340f8e4cc8fb5ea548796c5efbcb6f3f11d0fa32298a58a89081241bd1,
                0x9f31e2e26bbb71853ff100a5a37f405ae2419c074d6d2ede70c17377feb3898c
            ),
            "EIP-7951 precompile did not verify a known-good signature"
        );
    }

    // ==========================================================================================
    // B. The account Prism ships TODAY (Mera passkey-derived secp256k1) as a Circle Safe owner.
    // ==========================================================================================

    function test_B_MeraEoaOwner_CanSpendCircleUsdc() public {
        address[] memory owners = new address[](1);
        owners[0] = meraOwner;
        ISafe safe = _createSafe(owners, 1, 1);
        _fundUsdc(address(safe), 100e6);

        Spend memory s = _usdcSpend(safe, recipient, 20e6);
        bytes32 h = _hash(safe, s);
        (uint8 v, bytes32 r, bytes32 vs) = vm.sign(meraPk, h);

        vm.prank(relayer); // a relayer broadcasts; it is not an owner
        assertTrue(_exec(safe, s, abi.encodePacked(r, vs, v)));

        assertEq(IERC20(USDC).balanceOf(recipient), 20e6, "recipient was not paid");
        assertEq(IERC20(USDC).balanceOf(address(safe)), 80e6, "circle balance wrong");
        assertEq(safe.nonce(), 1, "nonce did not advance");
    }

    // ==========================================================================================
    // C. The archived P-256 PrismAccount's 1271 surface, verbatim, against a real Safe.
    // ==========================================================================================

    function test_C_ArchivedPrismAccount1271Surface_IsRejectedBySafe() public {
        ArchivedPrismAccount1271 archived = new ArchivedPrismAccount1271(qx0, qy0);
        address[] memory owners = new address[](1);
        owners[0] = address(archived);
        ISafe safe = _createSafe(owners, 1, 2);
        _fundUsdc(address(safe), 100e6);

        Spend memory s = _usdcSpend(safe, recipient, 20e6);
        bytes32 h = _hash(safe, s);
        bytes memory sig = _signP256(0, h); // a cryptographically PERFECT signature

        // Sanity: the archived surface itself accepts this signature on its own terms.
        assertEq(archived.isValidSignature(h, sig), bytes4(0x1626ba7e), "archived 1271 self-check failed");

        // But Safe v1.4.1 calls isValidSignature(bytes,bytes) and requires 0x20c13b0b. The
        // archived account has no such function, so the call reverts inside checkNSignatures.
        // Not GS024 ("contract signature rejected") but a bare revert: the function Safe calls
        // does not exist on the archived account at all, so the external call has nowhere to land.
        vm.prank(relayer);
        vm.expectRevert(bytes(""));
        _exec(safe, s, _contractSigEnvelope(address(archived), sig));

        assertEq(IERC20(USDC).balanceOf(recipient), 0, "funds moved despite incompatible owner");
    }

    // ==========================================================================================
    // D. The corrected P-256 owner surface: same key, same digest convention, Safe-callable.
    // ==========================================================================================

    function test_D_P256ContractOwner_CanSpendCircleUsdc() public {
        address[] memory owners = new address[](1);
        owners[0] = address(p256Owner);
        ISafe safe = _createSafe(owners, 1, 3);
        _fundUsdc(address(safe), 100e6);

        Spend memory s = _usdcSpend(safe, recipient, 20e6);
        bytes32 h = _hash(safe, s);
        bytes memory sig = _signP256(0, h);

        // Prove Safe really routes validation through the owner's legacy EIP-1271 entrypoint.
        vm.expectCall(address(p256Owner), abi.encodeWithSelector(bytes4(0x20c13b0b)));

        vm.prank(relayer);
        assertTrue(_exec(safe, s, _contractSigEnvelope(address(p256Owner), sig)));

        assertEq(IERC20(USDC).balanceOf(recipient), 20e6, "recipient was not paid");
        assertEq(safe.nonce(), 1, "nonce did not advance");
    }

    function test_D_TwoOfTwo_MeraEoaPlusP256Authority() public {
        address[] memory owners = _sorted(meraOwner, address(p256Owner));
        ISafe safe = _createSafe(owners, 2, 4);
        _fundUsdc(address(safe), 100e6);
        assertEq(safe.getThreshold(), 2);

        Spend memory s = _usdcSpend(safe, recipient, 35e6);
        bytes32 h = _hash(safe, s);
        (uint8 v, bytes32 r, bytes32 vs) = vm.sign(meraPk, h);
        bytes memory p256Sig = _signP256(0, h);

        vm.prank(relayer);
        assertTrue(
            _exec(safe, s, _mixedEnvelope(meraOwner, abi.encodePacked(r, vs, v), address(p256Owner), p256Sig))
        );
        assertEq(IERC20(USDC).balanceOf(recipient), 35e6, "2-of-2 spend did not settle");
    }

    function test_D_TwoOfTwo_RejectsASingleApproval() public {
        address[] memory owners = _sorted(meraOwner, address(p256Owner));
        ISafe safe = _createSafe(owners, 2, 5);
        _fundUsdc(address(safe), 100e6);

        Spend memory s = _usdcSpend(safe, recipient, 35e6);
        bytes32 h = _hash(safe, s);
        (uint8 v, bytes32 r, bytes32 vs) = vm.sign(meraPk, h);

        vm.prank(relayer);
        vm.expectRevert("GS020"); // not enough signature bytes for the threshold
        _exec(safe, s, abi.encodePacked(r, vs, v));
        assertEq(IERC20(USDC).balanceOf(recipient), 0);
    }

    // ==========================================================================================
    // E. Negative space. Every one of these MUST fail.
    // ==========================================================================================

    /// @dev Shared fixture: a 1-of-1 Circle owned by the P-256 authority, funded with 100 USDC.
    function _p256Circle(uint256 salt) internal returns (ISafe safe) {
        address[] memory owners = new address[](1);
        owners[0] = address(p256Owner);
        safe = _createSafe(owners, 1, salt);
        _fundUsdc(address(safe), 100e6);
    }

    function test_E_WrongP256Signer_Fails() public {
        ISafe safe = _p256Circle(10);
        Spend memory s = _usdcSpend(safe, recipient, 20e6);
        bytes memory sig = _signP256(1, _hash(safe, s)); // key index 1 is NOT this Circle's owner

        vm.prank(relayer);
        vm.expectRevert("GS024");
        _exec(safe, s, _contractSigEnvelope(address(p256Owner), sig));
        assertEq(IERC20(USDC).balanceOf(recipient), 0);
    }

    function test_E_ModifiedRecipient_Fails() public {
        ISafe safe = _p256Circle(11);
        Spend memory reviewed = _usdcSpend(safe, recipient, 20e6);
        bytes memory sig = _signP256(0, _hash(safe, reviewed));

        Spend memory tampered = _usdcSpend(safe, attacker, 20e6); // relayer redirects the payee
        vm.prank(relayer);
        vm.expectRevert("GS024");
        _exec(safe, tampered, _contractSigEnvelope(address(p256Owner), sig));
        assertEq(IERC20(USDC).balanceOf(attacker), 0);
    }

    function test_E_ModifiedAmount_Fails() public {
        ISafe safe = _p256Circle(12);
        Spend memory reviewed = _usdcSpend(safe, recipient, 20e6);
        bytes memory sig = _signP256(0, _hash(safe, reviewed));

        Spend memory tampered = _usdcSpend(safe, recipient, 90e6); // relayer resizes the payment
        vm.prank(relayer);
        vm.expectRevert("GS024");
        _exec(safe, tampered, _contractSigEnvelope(address(p256Owner), sig));
        assertEq(IERC20(USDC).balanceOf(recipient), 0);
    }

    function test_E_ModifiedTokenTarget_Fails() public {
        ISafe safe = _p256Circle(13);
        Spend memory reviewed = _usdcSpend(safe, recipient, 20e6);
        bytes memory sig = _signP256(0, _hash(safe, reviewed));

        Spend memory tampered = reviewed;
        tampered.to = address(0xDEAD); // relayer swaps the asset contract
        vm.prank(relayer);
        vm.expectRevert("GS024");
        _exec(safe, tampered, _contractSigEnvelope(address(p256Owner), sig));
    }

    function test_E_ModifiedOperationToDelegateCall_Fails() public {
        ISafe safe = _p256Circle(14);
        Spend memory reviewed = _usdcSpend(safe, recipient, 20e6);
        bytes memory sig = _signP256(0, _hash(safe, reviewed));

        Spend memory tampered = reviewed;
        tampered.operation = SafeOperation.DelegateCall; // the most dangerous possible escalation
        vm.prank(relayer);
        vm.expectRevert("GS024");
        _exec(safe, tampered, _contractSigEnvelope(address(p256Owner), sig));
    }

    function test_E_WrongSafeNonce_Fails() public {
        ISafe safe = _p256Circle(15);
        Spend memory s = _usdcSpend(safe, recipient, 20e6);
        Spend memory future = s;
        future.nonce = s.nonce + 1;
        bytes memory sig = _signP256(0, _hash(safe, future)); // signed against the wrong nonce

        vm.prank(relayer);
        vm.expectRevert("GS024");
        _exec(safe, s, _contractSigEnvelope(address(p256Owner), sig));
    }

    function test_E_ReplayOfExecutedTransaction_Fails() public {
        ISafe safe = _p256Circle(16);
        Spend memory s = _usdcSpend(safe, recipient, 20e6);
        bytes memory sig = _signP256(0, _hash(safe, s));
        bytes memory envelope = _contractSigEnvelope(address(p256Owner), sig);

        vm.prank(relayer);
        assertTrue(_exec(safe, s, envelope));
        assertEq(safe.nonce(), 1);

        // Byte-identical resubmission: the nonce has moved, so the hash no longer matches.
        vm.prank(relayer);
        vm.expectRevert("GS024");
        _exec(safe, s, envelope);
        assertEq(IERC20(USDC).balanceOf(recipient), 20e6, "replay double-paid the recipient");
    }

    function test_E_SignatureFromAnotherCircleSafe_Fails() public {
        ISafe circleA = _p256Circle(17);
        ISafe circleB = _p256Circle(18); // same owner, same threshold, different Safe address

        Spend memory sB = _usdcSpend(circleB, recipient, 20e6);
        bytes memory sigForB = _signP256(0, _hash(circleB, sB));

        // Same parameters, but presented to Circle A. The EIP-712 domain binds verifyingContract.
        Spend memory sA = _usdcSpend(circleA, recipient, 20e6);
        assertEq(_hash(circleA, sA) == _hash(circleB, sB), false, "two Safes produced the same hash");

        vm.prank(relayer);
        vm.expectRevert("GS024");
        _exec(circleA, sA, _contractSigEnvelope(address(p256Owner), sigForB));
    }

    function test_E_SignatureFromAnotherChainId_Fails() public {
        ISafe safe = _p256Circle(19);
        Spend memory s = _usdcSpend(safe, recipient, 20e6);

        // Recompute the digest under a different chainId, exactly as a cross-chain replay would.
        bytes32 foreignHash = _hashForChain(safe, s, 1);
        assertTrue(foreignHash != _hash(safe, s), "chainId did not change the digest");
        bytes memory sig = _signP256(0, foreignHash);

        vm.prank(relayer);
        vm.expectRevert("GS024");
        _exec(safe, s, _contractSigEnvelope(address(p256Owner), sig));
    }

    function test_E_TruncatedOrOversizedSignature_Fails() public {
        ISafe safe = _p256Circle(20);
        Spend memory s = _usdcSpend(safe, recipient, 20e6);
        bytes memory sig = _signP256(0, _hash(safe, s));

        bytes memory short_ = new bytes(63);
        for (uint256 i; i < 63; ++i) short_[i] = sig[i];
        vm.prank(relayer);
        vm.expectRevert("GS024");
        _exec(safe, s, _contractSigEnvelope(address(p256Owner), short_));

        bytes memory long_ = abi.encodePacked(sig, bytes1(0x00));
        vm.prank(relayer);
        vm.expectRevert("GS024");
        _exec(safe, s, _contractSigEnvelope(address(p256Owner), long_));
    }

    /// @dev Recomputes the Safe EIP-712 digest under an arbitrary chainId, mirroring Safe's own
    ///      `domainSeparator()` / `encodeTransactionData()` so a cross-chain replay can be staged.
    function _hashForChain(ISafe safe, Spend memory s, uint256 chainId) internal pure returns (bytes32) {
        bytes32 domainTypehash = 0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218;
        bytes32 safeTxTypehash = 0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8;
        bytes32 domain = keccak256(abi.encode(domainTypehash, chainId, address(safe)));
        bytes32 structHash = keccak256(
            abi.encode(
                safeTxTypehash,
                s.to,
                s.value,
                keccak256(s.data),
                s.operation,
                uint256(0),
                uint256(0),
                uint256(0),
                address(0),
                address(0),
                s.nonce
            )
        );
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), domain, structHash));
    }
}
