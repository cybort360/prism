# Save Demo + Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Prism Save run end-to-end on Monad testnet with real USDC and real shares (deposit → position → withdraw) behind a new `SAVE_MODE=demo`, without touching mainnet or fabricating balances.

**Architecture:** A minimal ERC-4626-style `MockVault` on testnet is the real on-chain substrate. The backend drops demo implementations into the existing Save seams — `routeProvider` (quote), `vaultReader` (position), and a new executor — all gated by `SAVE_MODE=demo`; `preview` stays the default. Authorization reuses the audited ERC-3009 signing path: the user signs a USDC `ReceiveWithAuthorization` to the vault for deposits, and a vault-native `RedeemWithAuthorization` for withdrawals; a MON-funded relayer submits both. iOS gains a demo banner and enables the deposit/withdraw flow.

**Tech Stack:** Solidity ^0.8.28 + Foundry (contracts); Node.js ESM + `node:test` + viem (backend); SwiftUI (iOS).

## Global Constraints

- **Money-truth (INV-M1/M2):** the balance/position shown is always an on-chain read; never an optimistic credit or fabricated APY. Demo yield is a real on-chain share-price change (`simulateYield`).
- **Copy rules:** demo Save says "Demo — simulated yield on testnet, not real earnAUSD." Never "guaranteed", "best APY", or "highest yield". `SAVE_MANAGED_COPY` in `saveService.js` remains the source of truth for managed copy.
- **Preview is default:** `SAVE_MODE` defaults to `preview`; existing preview behavior and `substrateVerified` (real mainnet earnAUSD) are untouched. `live` mode remains the future real path.
- **No mainnet:** everything runs on Monad testnet (chainId 10143) with MockUSDC + MockVault.
- **Commit rules:** NO Claude/Anthropic attribution in commit messages. Broadcast artifacts under `contracts/broadcast/` are NOT committed. Run `xcodegen generate` after adding/removing Swift files.
- **Relayer submits, user never pays gas:** deposits/withdrawals are one relayer `writeContract` over a user signature (mirrors payments).
- **Test commands:** contracts `cd contracts && forge test`; backend `cd backend && npm test`; iOS `cd ios && xcodegen generate && xcodebuild -project Prism.xcodeproj -scheme Prism -destination 'platform=iOS Simulator,name=iPhone 17' build`.

---

## Phase 1 — MockVault contract

### Task 1: MockVault.sol

**Files:**
- Create: `contracts/src/mocks/MockVault.sol`
- Test: `contracts/test/MockVault.t.sol`

**Interfaces:**
- Consumes: `contracts/src/mocks/MockUSDC.sol` (existing) — `receiveWithAuthorization`, `transfer`, `mint`, `balanceOf`.
- Produces (ABI later tasks rely on):
  - `depositWithAuthorization(address from, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) returns (uint256 shares)`
  - `redeemWithAuthorization(address owner, uint256 shares, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) returns (uint256 assets)`
  - `simulateYield(uint256 assets)` (owner only)
  - views: `balanceOf(address) returns (uint256)`, `convertToAssets(uint256) returns (uint256)`, `convertToShares(uint256) returns (uint256)`, `previewDeposit(uint256)`, `previewRedeem(uint256)`, `totalAssets()`, `totalSupply()`, `decimals()`
  - EIP-712 redeem domain: `name="Prism Save Demo Vault"`, `version="1"`, typehash `RedeemWithAuthorization(address owner,uint256 shares,uint256 validAfter,uint256 validBefore,bytes32 nonce)`

- [ ] **Step 1: Write the failing test** — `contracts/test/MockVault.t.sol`

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockVault} from "../src/mocks/MockVault.sol";

contract MockVaultTest is Test {
    MockUSDC usdc;
    MockVault vault;
    uint256 userPk = 0xA11CE;
    address user;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new MockVault(address(usdc));
        user = vm.addr(userPk);
        usdc.mint(user, 1_000_000000); // 1,000 USDC
    }

    // ---- helpers ----------------------------------------------------------
    function _usdcDomain() internal view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("USDC")), keccak256(bytes("2")), block.chainid, address(usdc)
        ));
    }

    function _signReceive(uint256 pk, address from, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        internal view returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(
            usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, va, vb, nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _usdcDomain(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function _signRedeem(uint256 pk, address owner_, uint256 shares, uint256 va, uint256 vb, bytes32 nonce)
        internal view returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(abi.encode(
            vault.REDEEM_WITH_AUTHORIZATION_TYPEHASH(), owner_, shares, va, vb, nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    // ---- tests ------------------------------------------------------------
    function test_firstDepositMintsOneToOne() public {
        bytes32 nonce = keccak256("d1");
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(userPk, user, address(vault), 100_000000, 0, block.timestamp + 3600, nonce);
        uint256 shares = vault.depositWithAuthorization(user, 100_000000, 0, block.timestamp + 3600, nonce, v, r, s);
        assertEq(shares, 100_000000);
        assertEq(vault.balanceOf(user), 100_000000);
        assertEq(usdc.balanceOf(address(vault)), 100_000000);
        assertEq(usdc.balanceOf(user), 900_000000);
    }

    function test_yieldRaisesRedeemValue() public {
        bytes32 nonce = keccak256("d2");
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(userPk, user, address(vault), 100_000000, 0, block.timestamp + 3600, nonce);
        vault.depositWithAuthorization(user, 100_000000, 0, block.timestamp + 3600, nonce, v, r, s);

        vault.simulateYield(10_000000); // +10 USDC into the vault -> +10% share price

        assertEq(vault.convertToAssets(100_000000), 110_000000);

        bytes32 rn = keccak256("r1");
        (uint8 rv, bytes32 rr, bytes32 rs) = _signRedeem(userPk, user, 100_000000, 0, block.timestamp + 3600, rn);
        uint256 assets = vault.redeemWithAuthorization(user, 100_000000, 0, block.timestamp + 3600, rn, rv, rr, rs);
        assertEq(assets, 110_000000);
        assertEq(vault.balanceOf(user), 0);
        assertEq(usdc.balanceOf(user), 1010_000000); // 1000 - 100 deposited + 110 redeemed
    }

    function test_redeemRejectsReusedNonce() public {
        bytes32 nonce = keccak256("d3");
        (uint8 v, bytes32 r, bytes32 s) = _signReceive(userPk, user, address(vault), 50_000000, 0, block.timestamp + 3600, nonce);
        vault.depositWithAuthorization(user, 50_000000, 0, block.timestamp + 3600, nonce, v, r, s);
        bytes32 rn = keccak256("r2");
        (uint8 rv, bytes32 rr, bytes32 rs) = _signRedeem(userPk, user, 25_000000, 0, block.timestamp + 3600, rn);
        vault.redeemWithAuthorization(user, 25_000000, 0, block.timestamp + 3600, rn, rv, rr, rs);
        vm.expectRevert(MockVault.AuthorizationUsed.selector);
        vault.redeemWithAuthorization(user, 25_000000, 0, block.timestamp + 3600, rn, rv, rr, rs);
    }

    function test_simulateYieldOwnerOnly() public {
        vm.prank(user);
        vm.expectRevert(MockVault.NotOwner.selector);
        vault.simulateYield(1_000000);
    }
}
```

> Note on `test_yieldRaisesRedeemValue`'s final assert: user starts 1,000, deposits 100 (→900), then redeems 100 shares now worth 110 (→1,010). `simulateYield` mints USDC into the vault (demo), so the user genuinely receives 110 for a net +10 gain. Correct.

- [ ] **Step 2: Run to verify it fails** — `cd contracts && forge test --match-contract MockVaultTest`. Expected: FAIL (`MockVault` not found / does not compile).

- [ ] **Step 3: Write `contracts/src/mocks/MockVault.sol`**

```solidity
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
```

- [ ] **Step 4: Run to verify it passes** — `cd contracts && forge test --match-contract MockVaultTest -vv`. Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add contracts/src/mocks/MockVault.sol contracts/test/MockVault.t.sol
git commit -m "Add MockVault demo vault (ERC-3009 deposit, authorized redeem, simulated yield)"
```

### Task 2: Deploy script + record address

**Files:**
- Create: `contracts/script/DeployMockVault.s.sol`
- Modify: `backend/.env` (local, gitignored) — add `SAVE_MOCK_VAULT` after deploy.

**Interfaces:**
- Consumes: existing testnet `MockUSDC` address (env `USDC_ADDRESS` in `backend/.env`, or deploy a fresh MockUSDC if the deployment uses one — check the existing deploy scripts in `contracts/script/`).
- Produces: a deployed `MockVault` address, saved as `SAVE_MOCK_VAULT`.

- [ ] **Step 1: Write `contracts/script/DeployMockVault.s.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MockVault} from "../src/mocks/MockVault.sol";

/// Deploys the demo Save vault over an existing MockUSDC. Set USDC_ADDRESS to the testnet MockUSDC.
contract DeployMockVault is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_ADDRESS");
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        MockVault vault = new MockVault(usdc);
        vm.stopBroadcast();
        console2.log("MockVault deployed at:", address(vault));
        console2.log("Set SAVE_MOCK_VAULT to the address above.");
    }
}
```

- [ ] **Step 2: Verify it compiles** — `cd contracts && forge build`. Expected: build succeeds.

- [ ] **Step 3: Deploy to testnet (operator step, not committed)**

Run (requires funded deployer key + RPC in env):
```bash
cd contracts && forge script script/DeployMockVault.s.sol:DeployMockVault \
  --rpc-url "$MONAD_TESTNET_RPC_URL" --broadcast
```
Copy the printed address into `backend/.env` as `SAVE_MOCK_VAULT=0x...`. Do NOT commit `backend/.env` or `contracts/broadcast/`.

- [ ] **Step 4: Commit (script only)**

```bash
git add contracts/script/DeployMockVault.s.sol
git commit -m "Add MockVault deploy script"
```

---

## Phase 2 — Backend demo mode

### Task 3: Config — SAVE_MODE + vault address

**Files:**
- Modify: `backend/src/config.js:134-154` (the `save:` block)
- Test: `backend/test/save-demo.test.js` (new)

**Interfaces:**
- Produces: `config.save.mode` (`'preview' | 'demo' | 'live'`, default `'preview'`), `config.save.demo` (boolean, `mode === 'demo'`), `config.save.mockVault` (address string or `''`).

- [ ] **Step 1: Write the failing test** — create `backend/test/save-demo.test.js`

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

test('config: SAVE_MODE defaults to preview, demo flag derived', async () => {
  delete process.env.SAVE_MODE;
  const { config } = await import(`../src/config.js?cfg=${Math.random()}`);
  assert.equal(config.save.mode, 'preview');
  assert.equal(config.save.demo, false);
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test test/save-demo.test.js`. Expected: FAIL (`config.save.mode` is undefined).

- [ ] **Step 3: Edit `backend/src/config.js`** — inside the `save: { ... }` object add these three fields (place after `enabled:`):

```javascript
    // Demo mode runs Save end-to-end on TESTNET against MockVault with real USDC + real shares.
    // 'preview' (default) = quotes only, no execution; 'demo' = MockVault on testnet; 'live' = real
    // mainnet earnAUSD (future). Only 'live' is real money on mainnet.
    mode: (() => { const m = env('SAVE_MODE', 'preview'); if (!['preview', 'demo', 'live'].includes(m)) throw new Error("SAVE_MODE must be 'preview', 'demo', or 'live'"); return m; })(),
    demo: env('SAVE_MODE', 'preview') === 'demo',
    mockVault: env('SAVE_MOCK_VAULT', ''),
```

- [ ] **Step 4: Run to verify it passes** — `cd backend && node --test test/save-demo.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/config.js backend/test/save-demo.test.js
git commit -m "Add SAVE_MODE config (preview/demo/live) + mock vault address"
```

### Task 4: Vault chain seam — the MockVault ABI + client helper

**Files:**
- Create: `backend/src/chain/mockVault.js`

**Interfaces:**
- Consumes: `chainProvider()` from `backend/src/providers/index.js` (provides `readContract(args)`, `writeContract(args)`, `getTransactionReceipt(hash)` — see `backend/src/chain/safeCircle.js` and `backend/src/providers/alchemyProvider.js:52-76`), `config.save.mockVault`.
- Produces:
  - `MOCK_VAULT_ABI` (viem ABI array with `depositWithAuthorization`, `redeemWithAuthorization`, `previewDeposit`, `convertToAssets`, `balanceOf`, `totalSupply`).
  - `mockVault` object: `available()`, `async previewDeposit(amountAtomic) -> string`, `async convertToAssets(sharesAtomic) -> string`, `async sharesOf(account) -> string`, `async submitDeposit({ from, amount, validAfter, validBefore, nonce, v, r, s }) -> txHash`, `async submitRedeem({ owner, shares, validAfter, validBefore, nonce, v, r, s }) -> txHash`.

- [ ] **Step 1: Read the provider seam** — open `backend/src/chain/safeCircle.js` and `backend/src/providers/alchemyProvider.js:60-80` to confirm the exact `readContract` / `writeContract` / receipt call shapes used elsewhere. Match them.

- [ ] **Step 2: Write `backend/src/chain/mockVault.js`**

```javascript
import { getAddress } from 'viem';
import { chainProvider } from '../providers/index.js';
import { config } from '../config.js';

// The demo Save vault (contracts/src/mocks/MockVault.sol). Real testnet reads/writes; the relayer
// submits deposits/redeems over the user's signature. Only used when config.save.mode === 'demo'.
export const MOCK_VAULT_ABI = [
  { type: 'function', name: 'previewDeposit', stateMutability: 'view', inputs: [{ name: 'assets', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'convertToAssets', stateMutability: 'view', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'depositWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' }, { name: 'amount', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }
    ], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'redeemWithAuthorization', stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' }, { name: 'shares', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }
    ], outputs: [{ type: 'uint256' }] }
];

function vaultAddress() {
  if (!config.save.mockVault) { const e = new Error('SAVE_MOCK_VAULT is not configured'); e.statusCode = 503; throw e; }
  return getAddress(config.save.mockVault);
}

export const mockVault = {
  available() { return config.save.mode === 'demo' && Boolean(config.save.mockVault); },

  async previewDeposit(amountAtomic) {
    const out = await chainProvider().readContract({ address: vaultAddress(), abi: MOCK_VAULT_ABI, functionName: 'previewDeposit', args: [BigInt(amountAtomic)] });
    return out.toString();
  },
  async convertToAssets(sharesAtomic) {
    const out = await chainProvider().readContract({ address: vaultAddress(), abi: MOCK_VAULT_ABI, functionName: 'convertToAssets', args: [BigInt(sharesAtomic)] });
    return out.toString();
  },
  async sharesOf(account) {
    const out = await chainProvider().readContract({ address: vaultAddress(), abi: MOCK_VAULT_ABI, functionName: 'balanceOf', args: [getAddress(account)] });
    return out.toString();
  },
  async submitDeposit({ from, amount, validAfter, validBefore, nonce, v, r, s }) {
    return chainProvider().writeContract({
      address: vaultAddress(), abi: MOCK_VAULT_ABI, functionName: 'depositWithAuthorization',
      args: [getAddress(from), BigInt(amount), BigInt(validAfter), BigInt(validBefore), nonce, Number(v), r, s]
    });
  },
  async submitRedeem({ owner, shares, validAfter, validBefore, nonce, v, r, s }) {
    return chainProvider().writeContract({
      address: vaultAddress(), abi: MOCK_VAULT_ABI, functionName: 'redeemWithAuthorization',
      args: [getAddress(owner), BigInt(shares), BigInt(validAfter), BigInt(validBefore), nonce, Number(v), r, s]
    });
  }
};
```

- [ ] **Step 3: Sanity check import** — `cd backend && node -e "import('./src/chain/mockVault.js').then(m=>console.log(Object.keys(m.mockVault)))"`. Expected: prints the method names. (If `chainProvider` import path differs, correct it to match `safeCircle.js`.)

- [ ] **Step 4: Commit**

```bash
git add backend/src/chain/mockVault.js
git commit -m "Add MockVault chain client (reads + relayer deposit/redeem submit)"
```

### Task 5: Demo route provider + demo vault reader

**Files:**
- Create: `backend/src/lib/demoSaveProviders.js`
- Test: add to `backend/test/save-demo.test.js`

**Interfaces:**
- Consumes: `mockVault` (Task 4), `config.save`, `receiveAuthorizationTypedData` from `backend/src/chain/eth.js` (existing), `randomHex` from `backend/src/lib/crypto.js`.
- Produces:
  - `DemoVaultSaveRouteProvider` with `name`, `async quoteSaveRoute({ account, amountAtomic }) -> quote` where the quote carries `demo:true`, `live:false`, `estimatedShares` (real `previewDeposit`), `minimumShares` (shares − slippage), a `nonce`, `deadline`, and an `authorization` object = `receiveAuthorizationTypedData({ from: account, to: vault, value: amount, validAfter: 0, validBefore: deadline, nonce })` for the client to sign.
  - `DemoVaultReader` with `available()`, `async sharesOf(account)`, `async convertToAssets(shares)`, `async apy()` (returns `null` — real APY is not projected in demo; realized yield still shows from value − principal).

- [ ] **Step 1: Write the failing test** — append to `backend/test/save-demo.test.js`

```javascript
test('demo route provider: executable quote with real shares + signable authorization', async () => {
  const { DemoVaultSaveRouteProvider } = await import('../src/lib/demoSaveProviders.js');
  const fakeVault = { available: () => true, previewDeposit: async () => '100000000' };
  const cfg = { save: { mode: 'demo', mockVault: '0x000000000000000000000000000000000000dEaD', maxSlippageBps: 50, substrateChainId: 10143, inputToken: '0x0000000000000000000000000000000000000001' } };
  const provider = new DemoVaultSaveRouteProvider(cfg, fakeVault);
  const q = await provider.quoteSaveRoute({ account: '0x00000000000000000000000000000000000000A1', amountAtomic: '100000000' });
  assert.equal(q.demo, true);
  assert.equal(q.live, false);
  assert.equal(q.estimatedShares, '100000000');
  assert.equal(q.minimumShares, '99500000'); // 100000000 - 0.50%
  assert.ok(q.authorization?.types?.ReceiveWithAuthorization, 'has signable ERC-3009 typed data');
  assert.ok(/^0x[0-9a-fA-F]{64}$/.test(q.nonce));
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test test/save-demo.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Write `backend/src/lib/demoSaveProviders.js`**

```javascript
import { getAddress } from 'viem';
import { receiveAuthorizationTypedData } from '../chain/eth.js';
import { randomHex } from './crypto.js';

const QUOTE_WINDOW_SECONDS = 300;

// Drop-in demo implementations behind SaveService's routeProvider seam and SavePositionService's
// vaultReader seam. They run the real MockVault on testnet: real previewDeposit shares, a real
// signable ERC-3009 authorization the user signs, and real on-chain position reads. Honest about
// being demo (demo:true, live:false); invents no APY.

export class DemoVaultSaveRouteProvider {
  constructor(config, vault) { this.config = config; this.vault = vault; }
  get name() { return 'demo-vault'; }

  async quoteSaveRoute({ account, amountAtomic }) {
    const s = this.config.save;
    const vault = getAddress(s.mockVault);
    const owner = getAddress(account);
    const shares = await this.vault.previewDeposit(String(amountAtomic));
    const minShares = (BigInt(shares) - (BigInt(shares) * BigInt(s.maxSlippageBps)) / 10000n).toString();
    const nonce = randomHex(32); // 0x + 64 hex
    const deadline = Math.floor(Date.now() / 1000) + QUOTE_WINDOW_SECONDS;

    // The user signs an ERC-3009 ReceiveWithAuthorization to the vault; the relayer submits
    // depositWithAuthorization. This is the exact money-moving authorization — one signature, one tx.
    const authorization = receiveAuthorizationTypedData({
      from: owner, to: vault, value: String(amountAtomic), validAfter: 0, validBefore: deadline, nonce
    });

    return {
      quoteId: `save_${randomHex(16).slice(2)}`,
      provider: this.name,
      demo: true,
      live: false,
      notLiveReason: 'Demo — simulated yield on testnet, not real earnAUSD',
      expiresAt: new Date(deadline * 1000).toISOString(),
      inputAsset: 'USDC',
      inputAmount: String(amountAtomic),
      vault,
      estimatedShares: String(shares),
      minimumShares: minShares,
      networkFeeSponsored: true,
      rate: { available: false, apyBps: null, reason: 'Demo — realized yield shows in your position value' },
      nonce,
      deadline,
      authorization,
      review: {
        youSaveAtomic: String(amountAtomic),
        estimatedInvestedAtomic: String(amountAtomic),
        estimatedInvestedIllustrative: false,
        conversionCostAtomic: '0',
        conversionCostBps: 0,
        minimumInvestedAtomic: String(amountAtomic),
        apy: { available: false, apyBps: null },
        expiresInSeconds: QUOTE_WINDOW_SECONDS,
        demo: true,
        live: false
      }
    };
  }
}

export class DemoVaultReader {
  constructor(config, vault) { this.config = config; this.vault = vault; }
  available() { return this.vault.available(); }
  async sharesOf(account) { return this.vault.sharesOf(account); }
  async convertToAssets(sharesAtomic) { return this.vault.convertToAssets(sharesAtomic); }
  async apy() { return null; } // no invented APY in demo; realized yield derives from value − principal
}
```

- [ ] **Step 4: Run to verify it passes** — `cd backend && node --test test/save-demo.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/demoSaveProviders.js backend/test/save-demo.test.js
git commit -m "Add demo Save route provider + vault reader (real testnet shares)"
```

### Task 6: Wire demo providers into SaveService + SavePositionService + state()

**Files:**
- Modify: `backend/src/services/saveService.js` (constructor default provider + `state()` + `quote()` persistence)
- Modify: `backend/src/services/savePositionService.js` (constructor default reader)
- Modify: `backend/src/server.js:62-63` (construct with the demo seams when `config.save.mode === 'demo'`)
- Test: add to `backend/test/save-demo.test.js`

**Interfaces:**
- Consumes: `DemoVaultSaveRouteProvider`, `DemoVaultReader` (Task 5), `mockVault` (Task 4).
- Produces: `saveService.state()` returns `demo: true` and `notLiveReason` demo copy when `config.save.mode==='demo'`; `saveService.quote()` in demo mode persists a pending quote to `store` under `saveQuotes[quoteId] = { quoteId, prismId, account, amountAtomic, vault, nonce, deadline, minimumShares, kind:'SAVE' }` (for Task 7 submit to verify).

- [ ] **Step 1: Write the failing test** — append to `backend/test/save-demo.test.js`

```javascript
import { JsonStore } from '../src/lib/jsonStore.js'; // adjust path if store module differs

function demoDeps() {
  const store = new JsonStore(':memory:'); // use the in-memory/tmp pattern other tests use
  const config = { save: { enabled: true, mode: 'demo', demo: true, mockVault: '0x000000000000000000000000000000000000dEaD', maxSlippageBps: 50, substrateChainId: 10143, inputToken: '0x0000000000000000000000000000000000000001', maxSaveAtomic: '10000000000' } };
  const identityService = { get: () => ({ prismId: 'prism_x', accountAddress: '0x00000000000000000000000000000000000000A1' }) };
  return { store, config, identityService };
}

test('saveService.state reports demo + persists quote', async () => {
  const { SaveService } = await import('../src/services/saveService.js');
  const { DemoVaultSaveRouteProvider } = await import('../src/lib/demoSaveProviders.js');
  const fakeVault = { available: () => true, previewDeposit: async () => '100000000' };
  const { store, config, identityService } = demoDeps();
  const svc = new SaveService({ store, config, identityService, routeProvider: new DemoVaultSaveRouteProvider(config, fakeVault) });
  const state = svc.state('prism_x');
  assert.equal(state.demo, true);
  const q = await svc.quote({ prismId: 'prism_x', amountAtomic: '100000000' });
  assert.equal(q.demo, true);
  assert.ok(store.read().saveQuotes[q.quoteId], 'quote persisted for submit');
});
```

> Note: match the exact `JsonStore` construction the other backend tests use (grep an existing test, e.g. `circle-withdrawals.test.js`, for the store setup helper and copy it). Replace the `demoDeps` store line accordingly.

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test test/save-demo.test.js`. Expected: FAIL (`state.demo` undefined / `quote` not async / no persistence).

- [ ] **Step 3: Edit `saveService.js`**

3a. Constructor: choose the demo provider by default when in demo mode. Change the `routeProvider` default:
```javascript
    this.routeProvider = routeProvider ?? (config.save.mode === 'demo'
      ? new DemoVaultSaveRouteProvider(config, mockVault)
      : new DevSaveRouteProvider(config));
```
Add imports at top of `saveService.js`:
```javascript
import { DemoVaultSaveRouteProvider } from '../lib/demoSaveProviders.js';
import { mockVault } from '../chain/mockVault.js';
```

3b. `state()`: add `demo` and demo-aware `notLiveReason`. In the returned object replace the `live`/`notLiveReason` lines with:
```javascript
      enabled: s.enabled,
      live: s.substrateVerified,
      demo: s.mode === 'demo',
      substrateVerified: s.substrateVerified,
      realMoneyEnabled: realSaveEnabled({ substrateVerified: s.substrateVerified, eligibility: eligibility.status }),
      notLiveReason: s.substrateVerified ? null : (s.mode === 'demo'
        ? 'Demo — simulated yield on testnet, not real earnAUSD'
        : 'Save is a preview — it goes live once earnAUSD is connected'),
```
Also change the preview `position` line so demo shows the real reconstructed position instead of a hardcoded zero — leave the hardcoded `position` only when NOT demo:
```javascript
      position: { shares: '0', valueAtomic: '0', currency: 'USDC' }, // overridden by /v1/save/position read
```
(No functional change needed here; `/v1/save/position` is the real read. Keep this line.)

3c. `quote()`: make it `async` (the demo provider is async) and persist the quote in demo mode. Change signature to `async quote(...)`, `await` the provider call, and after computing `quote` but before returning, add:
```javascript
    if (this.config.save.mode === 'demo') {
      this.store.mutate((data) => {
        data.saveQuotes ??= {};
        data.saveQuotes[quote.quoteId] = {
          quoteId: quote.quoteId, kind: 'SAVE', prismId, account: identity.accountAddress,
          amountAtomic: String(amount), vault: quote.vault, nonce: quote.nonce, deadline: quote.deadline,
          minimumShares: quote.minimumShares, estimatedShares: quote.estimatedShares, createdAt: new Date().toISOString()
        };
      });
    }
```
Note: in demo mode SKIP the `verifySaveExecutionPlan` block (it validates the AUSD-path plan, which the demo quote does not carry). Guard it: `if (this.config.save.mode !== 'demo') { ...existing verification... }` and set `planExecutable: true` for demo.

- [ ] **Step 4: Edit `savePositionService.js`** — constructor default reader:
```javascript
    this.vaultReader = vaultReader ?? (config.save.mode === 'demo'
      ? new DemoVaultReader(config, mockVault)
      : new PreviewVaultReader(config));
```
Add imports at top:
```javascript
import { DemoVaultReader } from '../lib/demoSaveProviders.js';
import { mockVault } from '../chain/mockVault.js';
```

- [ ] **Step 5: Update `/v1/save/quote` route to await** — in `backend/src/server.js`, the quote route handler must `await saveService.quote(...)` (find the `/v1/save/quote` route and add `await` / return the promise). Confirm `POST /v1/save/quote` exists; if quote is only reached via `/v1/save/prepare` → dispatcher, ensure the dispatcher `_prepareSave` `await`s `this.saves.quote(...)` (it already `await`s per intentDispatcherService.js:205).

- [ ] **Step 6: Run tests** — `cd backend && node --test test/save-demo.test.js`. Expected: PASS. Then full suite `npm test` — expect no regressions (preview path unchanged).

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/saveService.js backend/src/services/savePositionService.js backend/src/server.js backend/test/save-demo.test.js
git commit -m "Wire demo Save providers into service, position reader, and state()"
```

### Task 7: Deposit executor + `POST /v1/save/submit`

**Files:**
- Create: `backend/src/services/demoSaveExecutor.js`
- Modify: `backend/src/server.js` (add route + construct executor)
- Test: add to `backend/test/save-demo.test.js`

**Interfaces:**
- Consumes: `mockVault.submitDeposit` (Task 4), `verifyTypedData` / `splitSignature` from `backend/src/chain/eth.js`, `buildSaveOperation` from `backend/src/domain/savePosition.js`, the persisted `saveQuotes` record (Task 6), `chainProvider().getTransactionReceipt`.
- Produces: `DemoSaveExecutor.submitDeposit({ prismId, quoteId, signature }) -> { operationId, txHash, state }`. Writes a `saveOperations[operationId]` record (`kind:'SAVE'`) transitioning `CREATED → SUBMITTED (txHash) → SAVED` with `inputUSDC`, `sharesReceived` (from `previewDeposit`), `transactionHash`, `submittedAt`, `completedAt`.

- [ ] **Step 1: Write the failing test** — append to `backend/test/save-demo.test.js`

```javascript
test('demo executor: submit deposit verifies quote, submits, records SAVED op', async () => {
  const { DemoSaveExecutor } = await import('../src/services/demoSaveExecutor.js');
  const { store, config, identityService } = demoDeps();
  const account = '0x00000000000000000000000000000000000000A1';
  // Seed a quote as saveService.quote would.
  store.mutate((d) => { d.saveQuotes = { q1: { quoteId: 'q1', kind: 'SAVE', prismId: 'prism_x', account, amountAtomic: '100000000', vault: config.save.mockVault, nonce: '0x' + '11'.repeat(32), deadline: Math.floor(Date.now()/1000)+300, minimumShares: '99500000', estimatedShares: '100000000' } }; });
  const fakeVault = { available: () => true, submitDeposit: async () => '0xhash', sharesOf: async () => '100000000' };
  const fakeChain = { getTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n }) };
  // signature verification is stubbed to pass for this unit test:
  const exec = new DemoSaveExecutor({ store, config, identityService, vault: fakeVault, chain: fakeChain, verify: async () => true });
  const res = await exec.submitDeposit({ prismId: 'prism_x', quoteId: 'q1', signature: '0x' + 'ab'.repeat(65) });
  assert.equal(res.txHash, '0xhash');
  assert.equal(res.state, 'SAVED');
  const op = store.read().saveOperations[res.operationId];
  assert.equal(op.kind, 'SAVE');
  assert.equal(op.transactionHash, '0xhash');
  assert.equal(op.inputUSDC, '100000000');
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test test/save-demo.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Write `backend/src/services/demoSaveExecutor.js`**

```javascript
import { getAddress } from 'viem';
import { splitSignature, verifyTypedData, receiveAuthorizationTypedData } from '../chain/eth.js';
import { chainProvider } from '../providers/index.js';
import { mockVault as realVault } from '../chain/mockVault.js';
import { buildSaveOperation } from '../domain/savePosition.js';

function httpError(statusCode, message) { const e = new Error(message); e.statusCode = statusCode; return e; }

// DemoSaveExecutor — the executor seam for SAVE_MODE=demo. Verifies the user's ERC-3009 authorization
// against the persisted quote, has the relayer submit MockVault.depositWithAuthorization, waits for the
// receipt, and records a real SAVE operation (CREATED → SUBMITTED → SAVED) with the on-chain tx hash.
// No fabricated numbers: shares recorded are read back from the vault after settlement.
export class DemoSaveExecutor {
  constructor({ store, config, identityService, vault = realVault, chain = null, verify = null } = {}) {
    this.store = store;
    this.config = config;
    this.identities = identityService;
    this.vault = vault;
    this.chain = chain ?? chainProvider();
    this.verify = verify; // test seam; defaults to real verifyTypedData below
  }

  async submitDeposit({ prismId, quoteId, signature }) {
    if (this.config.save.mode !== 'demo') throw httpError(409, 'demo Save is not enabled');
    const quote = (this.store.read().saveQuotes ?? {})[quoteId];
    if (!quote || quote.prismId !== prismId || quote.kind !== 'SAVE') throw httpError(404, 'save quote not found');
    if (Math.floor(Date.now() / 1000) >= quote.deadline) throw httpError(409, 'this quote has expired — request a new one');

    const account = getAddress(quote.account);
    const vault = getAddress(quote.vault);
    const typed = receiveAuthorizationTypedData({
      from: account, to: vault, value: quote.amountAtomic, validAfter: 0, validBefore: quote.deadline, nonce: quote.nonce
    });
    const ok = this.verify ? await this.verify(typed, account, signature) : await verifyTypedData(typed, account, signature);
    if (!ok) throw httpError(400, 'authorization signature does not match');

    const { v, r, s } = splitSignature(signature);
    const positionId = `save_${account.toLowerCase()}`;

    // Record the operation BEFORE submit so a lost relayer response is still reconcilable.
    let op = buildSaveOperation({
      positionId, kind: 'SAVE', state: 'SUBMITTED',
      inputUSDC: quote.amountAtomic, quoteId, routeProvider: 'demo-vault',
      minimumShares: quote.minimumShares, submittedAt: new Date().toISOString()
    });
    this.store.mutate((data) => { data.saveOperations ??= {}; data.saveOperations[op.operationId] = op; });

    const txHash = await this.vault.submitDeposit({
      from: account, amount: quote.amountAtomic, validAfter: 0, validBefore: quote.deadline, nonce: quote.nonce, v, r, s
    });

    const receipt = await this.chain.getTransactionReceipt(txHash).catch(() => null);
    const confirmed = receipt && (receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1');
    const sharesReceived = await this.vault.sharesOf(account); // canonical readback

    this.store.mutate((data) => {
      const rec = data.saveOperations[op.operationId];
      rec.transactionHash = txHash;
      rec.blockNumber = receipt?.blockNumber ? Number(receipt.blockNumber) : null;
      rec.sharesReceived = sharesReceived;
      rec.actualAUSD = quote.amountAtomic;      // demo: USDC == asset, 1:1 into the vault's unit
      rec.state = confirmed ? 'SAVED' : 'CONFIRMING';
      rec.confirmedAt = confirmed ? new Date().toISOString() : null;
      rec.completedAt = confirmed ? new Date().toISOString() : null;
      op = rec;
    });

    return { operationId: op.operationId, txHash, state: op.state };
  }
}
```

- [ ] **Step 4: Add the route + construct executor in `server.js`** — near the other Save constructions (line ~62):
```javascript
import { DemoSaveExecutor } from './services/demoSaveExecutor.js';
const demoSaveExecutor = new DemoSaveExecutor({ store, config, identityService });
```
Add route (near the other `/v1/save/*` routes):
```javascript
route('POST', '/v1/save/submit', async ({ user, body, idempotencyKey }) => {
  rateLimit(`save-submit:${user.prismId}`, 30);
  requireSig(body.signature, 'signature');
  return withIdempotency(store, { scope: 'save-submit', key: idempotencyKey, actor: user.prismId, fingerprint: fingerprint(body.quoteId, body.signature) }, () =>
    demoSaveExecutor.submitDeposit({ prismId: user.prismId, quoteId: body.quoteId, signature: body.signature }));
}, true);
```
(Match `requireSig` / `withIdempotency` / `fingerprint` usage to the existing claim/aurora routes in the same file.)

- [ ] **Step 5: Run tests** — `cd backend && node --test test/save-demo.test.js`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/demoSaveExecutor.js backend/src/server.js backend/test/save-demo.test.js
git commit -m "Add demo Save deposit executor + POST /v1/save/submit"
```

### Task 8: Withdraw executor + `POST /v1/save/withdraw`

**Files:**
- Create: `backend/src/lib/redeemAuthorization.js` (typed-data helper for the vault's RedeemWithAuthorization)
- Modify: `backend/src/services/demoSaveExecutor.js` (add `submitWithdraw`)
- Modify: `backend/src/services/saveService.js` (`withdrawQuote` persists a demo redeem quote with a signable authorization)
- Modify: `backend/src/server.js` (route)
- Test: add to `backend/test/save-demo.test.js`

**Interfaces:**
- Consumes: `mockVault.submitRedeem` (Task 4), `mockVault.convertToAssets`.
- Produces:
  - `redeemAuthorizationTypedData({ owner, shares, validAfter, validBefore, nonce, vault, chainId }) -> typedData` with domain `{ name:'Prism Save Demo Vault', version:'1', chainId, verifyingContract: vault }`, primaryType `RedeemWithAuthorization`, matching the contract typehash exactly.
  - `saveService.withdrawQuote` in demo mode returns `demo:true`, `authorization` (redeem typed data), `nonce`, `deadline`, `estimatedUSDC` (real `convertToAssets`), and persists `saveQuotes[quoteId]` with `kind:'WITHDRAW_INSTANT'`.
  - `DemoSaveExecutor.submitWithdraw({ prismId, quoteId, signature }) -> { operationId, txHash, state }`, recording a `WITHDRAW_INSTANT` op (`AVAILABLE` on confirm) with `sharesRedeemed`, `outputUSDC`, `transactionHash`.

- [ ] **Step 1: Write the failing test** — append to `backend/test/save-demo.test.js`

```javascript
test('redeem typed data matches the contract domain + type', async () => {
  const { redeemAuthorizationTypedData } = await import('../src/lib/redeemAuthorization.js');
  const td = redeemAuthorizationTypedData({ owner: '0x00000000000000000000000000000000000000A1', shares: '100000000', validAfter: 0, validBefore: 999, nonce: '0x' + '22'.repeat(32), vault: '0x000000000000000000000000000000000000dEaD', chainId: 10143 });
  assert.equal(td.domain.name, 'Prism Save Demo Vault');
  assert.equal(td.domain.version, '1');
  assert.equal(td.primaryType, 'RedeemWithAuthorization');
  assert.deepEqual(td.types.RedeemWithAuthorization.map(f => f.name), ['owner','shares','validAfter','validBefore','nonce']);
});

test('demo executor: submit withdraw records AVAILABLE op with USDC out', async () => {
  const { DemoSaveExecutor } = await import('../src/services/demoSaveExecutor.js');
  const { store, config, identityService } = demoDeps();
  const account = '0x00000000000000000000000000000000000000A1';
  store.mutate((d) => { d.saveQuotes = { w1: { quoteId: 'w1', kind: 'WITHDRAW_INSTANT', prismId: 'prism_x', account, sharesAtomic: '100000000', vault: config.save.mockVault, nonce: '0x' + '33'.repeat(32), deadline: Math.floor(Date.now()/1000)+300, estimatedUSDC: '110000000' } }; });
  const fakeVault = { available: () => true, submitRedeem: async () => '0xwd', convertToAssets: async () => '110000000' };
  const fakeChain = { getTransactionReceipt: async () => ({ status: 'success', blockNumber: 2n }) };
  const exec = new DemoSaveExecutor({ store, config, identityService, vault: fakeVault, chain: fakeChain, verify: async () => true });
  const res = await exec.submitWithdraw({ prismId: 'prism_x', quoteId: 'w1', signature: '0x' + 'cd'.repeat(65) });
  assert.equal(res.txHash, '0xwd');
  assert.equal(res.state, 'AVAILABLE');
  const op = store.read().saveOperations[res.operationId];
  assert.equal(op.kind, 'WITHDRAW_INSTANT');
  assert.equal(op.outputUSDC, '110000000');
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && node --test test/save-demo.test.js`. Expected: FAIL.

- [ ] **Step 3: Write `backend/src/lib/redeemAuthorization.js`**

```javascript
import { getAddress } from 'viem';
import { verifyTypedData } from '../chain/eth.js';

const REDEEM_FIELDS = [
  { name: 'owner', type: 'address' },
  { name: 'shares', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' }
];

// Typed data for MockVault.redeemWithAuthorization. MUST match the contract's EIP-712 domain
// (name "Prism Save Demo Vault", version "1", verifyingContract = the vault) and typehash exactly.
export function redeemAuthorizationTypedData({ owner, shares, validAfter, validBefore, nonce, vault, chainId }) {
  return {
    domain: { name: 'Prism Save Demo Vault', version: '1', chainId: Number(chainId), verifyingContract: getAddress(vault) },
    primaryType: 'RedeemWithAuthorization',
    types: { RedeemWithAuthorization: REDEEM_FIELDS },
    message: {
      owner: getAddress(owner), shares: BigInt(shares),
      validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce
    }
  };
}

export async function verifyRedeemAuthorization(params, signature) {
  try { return await verifyTypedData(redeemAuthorizationTypedData(params), params.owner, signature); }
  catch { return false; }
}
```

- [ ] **Step 4: Add `submitWithdraw` to `demoSaveExecutor.js`**

```javascript
// add imports at top:
import { redeemAuthorizationTypedData } from '../lib/redeemAuthorization.js';

// add method to DemoSaveExecutor:
  async submitWithdraw({ prismId, quoteId, signature }) {
    if (this.config.save.mode !== 'demo') throw httpError(409, 'demo Save is not enabled');
    const quote = (this.store.read().saveQuotes ?? {})[quoteId];
    if (!quote || quote.prismId !== prismId || quote.kind !== 'WITHDRAW_INSTANT') throw httpError(404, 'withdraw quote not found');
    if (Math.floor(Date.now() / 1000) >= quote.deadline) throw httpError(409, 'this quote has expired — request a new one');

    const account = getAddress(quote.account);
    const params = { owner: account, shares: quote.sharesAtomic, validAfter: 0, validBefore: quote.deadline, nonce: quote.nonce, vault: getAddress(quote.vault), chainId: this.config.save.substrateChainId };
    const typed = redeemAuthorizationTypedData(params);
    const ok = this.verify ? await this.verify(typed, account, signature) : await verifyTypedData(typed, account, signature);
    if (!ok) throw httpError(400, 'authorization signature does not match');

    const { v, r, s } = splitSignature(signature);
    const positionId = `save_${account.toLowerCase()}`;
    let op = buildSaveOperation({
      positionId, kind: 'WITHDRAW_INSTANT', state: 'REDEEMING',
      sharesRedeemed: quote.sharesAtomic, quoteId, routeProvider: 'demo-vault', submittedAt: new Date().toISOString()
    });
    this.store.mutate((data) => { data.saveOperations ??= {}; data.saveOperations[op.operationId] = op; });

    const txHash = await this.vault.submitRedeem({
      owner: account, shares: quote.sharesAtomic, validAfter: 0, validBefore: quote.deadline, nonce: quote.nonce, v, r, s
    });
    const receipt = await this.chain.getTransactionReceipt(txHash).catch(() => null);
    const confirmed = receipt && (receipt.status === 'success' || receipt.status === 1 || receipt.status === '0x1');
    const outputUSDC = quote.estimatedUSDC ?? await this.vault.convertToAssets(quote.sharesAtomic);

    this.store.mutate((data) => {
      const rec = data.saveOperations[op.operationId];
      rec.transactionHash = txHash;
      rec.blockNumber = receipt?.blockNumber ? Number(receipt.blockNumber) : null;
      rec.outputUSDC = outputUSDC;
      rec.state = confirmed ? 'AVAILABLE' : 'CONFIRMING';
      rec.confirmedAt = confirmed ? new Date().toISOString() : null;
      rec.completedAt = confirmed ? new Date().toISOString() : null;
      op = rec;
    });
    return { operationId: op.operationId, txHash, state: op.state };
  }
```

- [ ] **Step 5: `saveService.withdrawQuote` demo branch** — in demo mode, read shares→USDC from the vault, persist the quote, and return a signable redeem authorization. Add at the top of `withdrawQuote`, after the identity check:
```javascript
    if (this.config.save.mode === 'demo') {
      const { redeemAuthorizationTypedData } = await import('../lib/redeemAuthorization.js');
      const vault = this.config.save.mockVault;
      const estimatedUSDC = await mockVault.convertToAssets(String(sharesAtomic));
      const nonce = randomHex(32);
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const quoteId = `wd_${randomHex(16).slice(2)}`;
      this.store.mutate((data) => {
        data.saveQuotes ??= {};
        data.saveQuotes[quoteId] = { quoteId, kind: 'WITHDRAW_INSTANT', prismId, account: identity.accountAddress, sharesAtomic: String(sharesAtomic), vault, nonce, deadline, estimatedUSDC };
      });
      return {
        quoteId, demo: true, live: false, returnsTo: 'USDC', estimatedUSDC,
        notLiveReason: 'Demo — simulated yield on testnet, not real earnAUSD',
        authorization: redeemAuthorizationTypedData({ owner: identity.accountAddress, shares: String(sharesAtomic), validAfter: 0, validBefore: deadline, nonce, vault, chainId: this.config.save.substrateChainId }),
        nonce, deadline
      };
    }
```
Make `withdrawQuote` `async`. Ensure `randomHex` and `mockVault` are imported in `saveService.js` (mockVault import added in Task 6; add `import { randomHex } from '../lib/crypto.js';` — already present).

- [ ] **Step 6: Add the route** — in `server.js`:
```javascript
route('POST', '/v1/save/withdraw', async ({ user, body, idempotencyKey }) => {
  rateLimit(`save-withdraw:${user.prismId}`, 30);
  requireSig(body.signature, 'signature');
  return withIdempotency(store, { scope: 'save-withdraw', key: idempotencyKey, actor: user.prismId, fingerprint: fingerprint(body.quoteId, body.signature) }, () =>
    demoSaveExecutor.submitWithdraw({ prismId: user.prismId, quoteId: body.quoteId, signature: body.signature }));
}, true);
```
Also ensure `/v1/save/withdraw/quote` route `await`s the now-async `withdrawQuote`.

- [ ] **Step 7: Run tests** — `cd backend && node --test test/save-demo.test.js` then `npm test`. Expected: PASS, no regressions.

- [ ] **Step 8: Commit**

```bash
git add backend/src/lib/redeemAuthorization.js backend/src/services/demoSaveExecutor.js backend/src/services/saveService.js backend/src/server.js backend/test/save-demo.test.js
git commit -m "Add demo Save withdraw executor + POST /v1/save/withdraw"
```

---

## Phase 3 — iOS

### Task 9: Models + API methods

**Files:**
- Modify: `ios/Prism/Models/*` — the `SaveState` and `SaveQuote` Codables (find them: `grep -rn "struct SaveState\|struct SaveQuote\|struct WithdrawQuote" ios/Prism`)
- Modify: `ios/Prism/Services/PrismAPI.swift:40-48`

**Interfaces:**
- Consumes: backend `/v1/save/quote` (now returns `demo`, `nonce`, `deadline`, `authorization`, `minimumShares`), `/v1/save/submit`, `/v1/save/withdraw/quote`, `/v1/save/withdraw`, `/v1/save/state` (now returns `demo`).
- Produces: Swift methods `saveSubmit(quoteId:signature:)`, `saveWithdrawSubmit(quoteId:signature:)`; `SaveState.demo: Bool`; `SaveQuote` gains `demo`, `quoteId`, `nonce`, `deadline`, `authorization` (typed-data JSON), `minimumShares`; a `SaveSubmitResult { operationId, txHash, state }`.

- [ ] **Step 1: Add `demo` to `SaveState`** — add `let demo: Bool?` (optional for backward-compat). Add to `SaveQuote`: `let demo: Bool?`, `let quoteId: String?`, `let nonce: String?`, `let deadline: Double?`, `let minimumShares: String?`, and an `authorization` field typed to the app's existing EIP-712 typed-data model (find how payments decode the token authorization typed data — reuse that type; `grep -rn "typedData\|TypedData\|authorization" ios/Prism/Models`). If payments use a raw `AnyCodable`/dictionary, mirror it.

- [ ] **Step 2: Add API methods to `PrismAPI.swift`**

```swift
  struct SaveSubmitBody: Encodable { let quoteId: String; let signature: String }
  struct SaveSubmitResult: Decodable { let operationId: String; let txHash: String?; let state: String }

  func saveSubmit(quoteId: String, signature: String) async throws -> SaveSubmitResult {
    try await api.send("/v1/save/submit", body: SaveSubmitBody(quoteId: quoteId, signature: signature))
  }
  func saveWithdrawSubmit(quoteId: String, signature: String) async throws -> SaveSubmitResult {
    try await api.send("/v1/save/withdraw", body: SaveSubmitBody(quoteId: quoteId, signature: signature))
  }
```

- [ ] **Step 3: Build** — `cd ios && xcodegen generate && xcodebuild -project Prism.xcodeproj -scheme Prism -destination 'platform=iOS Simulator,name=iPhone 17' build`. Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit**

```bash
git add ios/Prism/Models ios/Prism/Services/PrismAPI.swift ios/Prism.xcodeproj
git commit -m "Add demo Save API methods + demo/authorization fields to Save models"
```

### Task 10: SaveView demo banner + deposit flow

**Files:**
- Modify: `ios/Prism/Features/Save/SaveView.swift`
- Reference (signing): the payment token-authorization signer — `grep -rn "signTokenAuthorization\|MeraAccount\|sign(typed" ios/Prism` to find how a payment's ERC-3009 authorization is signed on the Mera account, and reuse it verbatim for the Save deposit.

**Interfaces:**
- Consumes: `saveState()`, `saveQuote(amountAtomic:)`, `saveSubmit(quoteId:signature:)`; the Mera signer used by payments.
- Produces: a working deposit flow: amount → quote → Face ID/PIN → sign the quote's `authorization` typed data on the Mera account → `saveSubmit` → refresh position. A demo banner shown when `state.demo == true`.

- [ ] **Step 1: Add the demo banner** — in `SaveView`'s body, when `state?.demo == true`, render above the amount entry:
```swift
if state?.demo == true {
  HStack(spacing: 8) {
    Image(systemName: "flask.fill").foregroundStyle(PrismTheme.mintDeep)
    Text("Demo — simulated yield on testnet, not real earnAUSD")
      .font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted)
      .fixedSize(horizontal: false, vertical: true)
  }
  .padding(12)
  .frame(maxWidth: .infinity, alignment: .leading)
  .background(PrismTheme.surface)
  .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
}
```

- [ ] **Step 2: Wire the deposit action** — on confirm, after Face ID/PIN:
```swift
let quote = try await PrismAPI.shared.saveQuote(amountAtomic: atomic)
guard let quoteId = quote.quoteId, let auth = quote.authorization else { throw SaveError.notLive }
let signature = try await meraSigner.signTypedData(auth)   // reuse the payment ERC-3009 signer
let result = try await PrismAPI.shared.saveSubmit(quoteId: quoteId, signature: signature)
// success: refresh position; show a receipt using result.txHash
```
Match the exact signer call name found in the reference grep. If payments sign via a coordinator, route the deposit through the same coordinator method rather than calling the signer directly.

- [ ] **Step 3: Build** — `cd ios && xcodegen generate && xcodebuild ... build`. Expected: BUILD SUCCEEDED.

- [ ] **Step 4: Commit**

```bash
git add ios/Prism/Features/Save/SaveView.swift
git commit -m "SaveView: demo banner + working demo deposit flow"
```

### Task 11: WithdrawView demo flow

**Files:**
- Modify: `ios/Prism/Features/Save/WithdrawView.swift`

**Interfaces:**
- Consumes: `saveWithdrawQuote(sharesAtomic:)` (now returns `authorization`/`quoteId` in demo), `saveWithdrawSubmit(quoteId:signature:)`, the Mera signer.
- Produces: a working withdraw: choose amount/shares → quote → Face ID/PIN → sign the redeem `authorization` → `saveWithdrawSubmit` → refresh position.

- [ ] **Step 1: Wire the withdraw action** — mirror Task 10 Step 2 using the withdraw quote + `saveWithdrawSubmit`. Show the demo banner when the withdraw quote returns `demo == true`.

- [ ] **Step 2: Build** — `cd ios && xcodegen generate && xcodebuild ... build`. Expected: BUILD SUCCEEDED.

- [ ] **Step 3: Commit**

```bash
git add ios/Prism/Features/Save/WithdrawView.swift
git commit -m "WithdrawView: working demo withdraw flow"
```

### Task 12: End-to-end smoke + close-out

**Files:** none (verification task)

- [ ] **Step 1: Backend up in demo mode** — set `SAVE_MODE=demo` and `SAVE_MOCK_VAULT=<deployed>` in `backend/.env`, start the backend (`set -a; . ./.env; set +a; node src/server.js` or the project's start script).
- [ ] **Step 2: Simulator smoke** — in the running app (with `feature.save` enabled): deposit an amount → confirm the demo banner, Face ID, and that Activity/position shows real shares. Then, from the operator side, call `simulateYield` on the vault (`cast send $SAVE_MOCK_VAULT "simulateYield(uint256)" 5000000 --rpc-url ... --private-key <owner>`), refresh the position, and confirm the value increased. Then withdraw and confirm USDC returns to the balance.
- [ ] **Step 3: Full test pass** — `cd contracts && forge test` (all green), `cd backend && npm test` (all green, no preview regressions), `cd ios && xcodebuild ... build` (BUILD SUCCEEDED).
- [ ] **Step 4: Final commit if any cleanup** — otherwise the sub-project is complete on branch `feat/save-demo-foundation`.

---

## Self-Review

**Spec coverage:**
- MockVault.sol (deposit/redeem/yield) → Task 1. Deploy + address → Task 2.
- `SAVE_MODE` config + `demo` flag → Task 3.
- `DemoVaultSaveRouteProvider` (executable plan, real min-shares) → Task 5/6.
- `DemoSaveExecutor` (relayer submit, real tx hash, lifecycle) → Task 7 (deposit), Task 8 (withdraw).
- `POST /v1/save/submit`, `POST /v1/save/withdraw` → Task 7/8. Prepare→sign flow reuses ERC-3009 typed data → Task 5 (authorization in quote) + Task 10.
- `savePositionService` reads real MockVault shares → Task 6 (`DemoVaultReader`).
- iOS demo banner + deposit + withdraw → Tasks 9–11.
- Invariants/copy (money-truth, demo copy, preview-default) → Global Constraints + Task 6 `state()` + Task 5 copy.
- Testing (Foundry, backend, iOS) → per-task + Task 12.

**Placeholder scan:** No TBD/TODO. Two deliberate "match the existing pattern" instructions (store construction in tests; the Mera signer call name; `requireSig`/`withIdempotency` usage) point at named existing code the implementer must read — not invented APIs.

**Type consistency:** `depositWithAuthorization`/`redeemWithAuthorization` arg order identical in contract (Task 1), ABI (Task 4), and executor calls (Tasks 7/8). `saveQuotes` record shape written in Task 6/8 matches reads in Tasks 7/8. `buildSaveOperation` fields (`inputUSDC`, `sharesReceived`, `outputUSDC`, `transactionHash`) match `reconstructPosition` consumption. Redeem typed data (Task 8) matches the contract typehash/domain (Task 1) — asserted in a test.

**Open item the implementer must confirm (not a blocker):** the exact `chainProvider()` accessor path/name (`backend/src/chain/index.js` vs re-export) and the Mera signer method name — both are read-and-match steps, not new code.
