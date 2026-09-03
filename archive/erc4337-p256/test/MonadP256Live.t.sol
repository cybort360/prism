// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {P256Verifier} from "../src/libraries/P256Verifier.sol";

/// @notice Live proof against Monad's EIP-7951 precompile. Requires MONAD_TESTNET_RPC_URL.
contract MonadP256LiveTest is Test {
    function testLiveP256PrecompileAcceptsKnownSignature() public {
        string memory rpc = vm.envString("MONAD_TESTNET_RPC_URL");
        vm.createSelectFork(rpc);

        bytes32 digest = 0x19c7a5c016ecf09862d33a4bd8eb4a95ab22acb6446e38159946ad7e08b42305;
        uint256 r = 0xed3485d78b6a00b8b5785210de5b05033e2d5fccbe1653189b0c9110d4b06c95;
        uint256 s = 0xcf5fd1ea40db4ccc0f1d80addad5be00d2177c42ecf2060f4074a635bc379717;
        uint256 qx = 0x7a0d5f340f8e4cc8fb5ea548796c5efbcb6f3f11d0fa32298a58a89081241bd1;
        uint256 qy = 0x9f31e2e26bbb71853ff100a5a37f405ae2419c074d6d2ede70c17377feb3898c;

        assertTrue(P256Verifier.verify(digest, r, s, qx, qy));
        assertFalse(P256Verifier.verify(digest, r + 1, s, qx, qy));
    }
}
