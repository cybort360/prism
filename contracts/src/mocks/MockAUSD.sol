// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockAUSD
/// @notice Test-only faithful reproduction of Agora AUSD's ERC-20 + ERC-3009 surface.
/// @dev The EIP-712 domain deliberately matches the live AUSD token
///      (name "Agora Dollar", version "1", 6 decimals) so that a signature produced for the
///      real token by a Mera account validates identically against this mock in Foundry tests.
///      Real AUSD: Monad mainnet 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a (chainId 143),
///      Monad testnet 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC (chainId 10143).
contract MockAUSD {
    string public name = "Agora Dollar";
    string public symbol = "AUSD";
    uint8 public constant decimals = 6;
    string public version = "1";

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationUsedOrCanceled();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error InvalidSignature();
    error CallerMustBePayee();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ALLOWANCE");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this))
        );
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _verifyAuthorization(
            from, nonce, validAfter, validBefore,
            keccak256(abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)),
            v, r, s
        );
        _markUsed(from, nonce);
        _transfer(from, to, value);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (to != msg.sender) revert CallerMustBePayee();
        _verifyAuthorization(
            from, nonce, validAfter, validBefore,
            keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)),
            v, r, s
        );
        _markUsed(from, nonce);
        _transfer(from, to, value);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationUsedOrCanceled();
        bytes32 digest = _eip712(keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)));
        if (_recover(digest, v, r, s) != authorizer) revert InvalidSignature();
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function _verifyAuthorization(
        address from,
        bytes32 nonce,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 structHash,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal view {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationUsedOrCanceled();
        if (_recover(_eip712(structHash), v, r, s) != from) revert InvalidSignature();
    }

    function _markUsed(address from, bytes32 nonce) internal {
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }

    function _eip712(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
        // Reject malleable high-s signatures (EIP-2).
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert InvalidSignature();
        if (v != 27 && v != 28) revert InvalidSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "BALANCE");
        unchecked { balanceOf[from] -= amount; }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
