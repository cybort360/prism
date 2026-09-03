// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrismAccount} from "./PrismAccount.sol";

/// @notice Deterministic factory for counterfactual Prism accounts.
contract PrismAccountFactory {
    address public immutable entryPoint;

    event AccountCreated(address indexed account, bytes32 indexed salt, uint256 qx, uint256 qy);

    constructor(address entryPoint_) {
        require(entryPoint_ != address(0), "ENTRYPOINT_ZERO");
        entryPoint = entryPoint_;
    }

    function createAccount(uint256 qx, uint256 qy, bytes32 salt) external returns (PrismAccount account) {
        address predicted = getAddress(qx, qy, salt);
        if (predicted.code.length != 0) return PrismAccount(payable(predicted));

        account = new PrismAccount{salt: salt}(entryPoint, qx, qy);
        emit AccountCreated(address(account), salt, qx, qy);
    }

    function getAddress(uint256 qx, uint256 qy, bytes32 salt) public view returns (address predicted) {
        bytes memory init = abi.encodePacked(
            type(PrismAccount).creationCode,
            abi.encode(entryPoint, qx, qy)
        );
        bytes32 hash = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(init))
        );
        predicted = address(uint160(uint256(hash)));
    }
}
