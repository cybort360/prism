// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IPrismClaimVault {
    function createClaim(bytes32 claimId, bytes32 recipientReference, address token, uint256 amount, uint64 expiry) external;
    function claim(bytes32 claimId, address recipientAccount, uint64 aliasVersion, uint256 nonce, uint64 deadline, bytes calldata authorization) external;
    function refund(bytes32 claimId) external;
}
