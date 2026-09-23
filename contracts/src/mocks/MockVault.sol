// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IUSDCLike {
    function receiveWithAuthorization(
        address from, address to, uint256 value,
        uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function mint(address to, uint256 amount) external;
    function balanceOf(address) external view returns (uint256);
}

/// @notice Minimal ERC-4626-style demo vault over MockUSDC for Prism Save DEMO mode.
/// Real USDC in -> shares minted; real USDC out on redeem. Yield is a real on-chain
/// share-price change via simulateYield(). Testnet demo only — NOT for mainnet.
contract MockVault {
    string public constant name = "Prism Save Demo Vault";
    string public constant symbol = "psvUSDC";
    string public constant version = "1";
    uint8 public constant decimals = 6;

    IUSDCLike public immutable asset;
    address public owner;

    uint256 public totalSupply;                    // total shares
    mapping(address => uint256) public balanceOf;  // shares per holder
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    bytes32 public constant REDEEM_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "RedeemWithAuthorization(address owner,uint256 shares,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    event Deposit(address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(address indexed owner, uint256 assets, uint256 shares);
    event YieldAccrued(uint256 assets);

    error NotOwner();
    error ZeroAmount();
    error AuthorizationUsed();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error InvalidSignature();
    error InsufficientShares();

    constructor(address asset_) {
        asset = IUSDCLike(asset_);
        owner = msg.sender;
    }

    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply;
        uint256 total = totalAssets();
        if (supply == 0 || total == 0) return assets; // 1:1 on first deposit
        return (assets * supply) / total;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0) return shares;
        return (shares * totalAssets()) / supply;
    }

    function previewDeposit(uint256 assets) external view returns (uint256) { return convertToShares(assets); }
    function previewRedeem(uint256 shares) external view returns (uint256) { return convertToAssets(shares); }

    /// @notice Pull `amount` USDC from `from` via their signed ReceiveWithAuthorization to this
    /// vault, then mint shares to `from`. Relayer-submittable; `from` never pays gas.
    function depositWithAuthorization(
        address from, uint256 amount,
        uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        shares = convertToShares(amount); // price on pre-deposit assets
        asset.receiveWithAuthorization(from, address(this), amount, validAfter, validBefore, nonce, v, r, s);
        totalSupply += shares;
        balanceOf[from] += shares;
        emit Deposit(from, amount, shares);
    }

    /// @notice Burn `owner`'s shares (authorized by their EIP-712 signature) and send USDC to them.
    function redeemWithAuthorization(
        address owner_, uint256 shares,
        uint256 validAfter, uint256 validBefore, bytes32 nonce,
        uint8 v, bytes32 r, bytes32 s
    ) external returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (authorizationState[owner_][nonce]) revert AuthorizationUsed();
        bytes32 structHash =
            keccak256(abi.encode(REDEEM_WITH_AUTHORIZATION_TYPEHASH, owner_, shares, validAfter, validBefore, nonce));
        if (_recover(_eip712(structHash), v, r, s) != owner_) revert InvalidSignature();
        if (balanceOf[owner_] < shares) revert InsufficientShares();
        authorizationState[owner_][nonce] = true;
        assets = convertToAssets(shares);
        totalSupply -= shares;
        balanceOf[owner_] -= shares;
        asset.transfer(owner_, assets);
        emit Withdraw(owner_, assets, shares);
    }

    /// @notice Demo yield: mint USDC into the vault so assets-per-share rises. Owner only.
    function simulateYield(uint256 assets) external {
        if (msg.sender != owner) revert NotOwner();
        asset.mint(address(this), assets);
        emit YieldAccrued(assets);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this)
        ));
    }

    function _eip712(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
        if (v != 27 && v != 28) revert InvalidSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }
}
