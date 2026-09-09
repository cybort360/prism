import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, createPublicClient, http } from 'viem';
import { config } from '../config.js';
import { relayerAccount } from './eth.js';

// Real chain ops for the device-P256 → PrismP256Account path. Lazy so importing this never needs an
// RPC. The relayer deploys the account and submits pay() (pays gas); the account owner needs no MON.

const __dir = path.dirname(fileURLToPath(import.meta.url));
let _artifact;
function artifact() {
  if (!_artifact) {
    _artifact = JSON.parse(fs.readFileSync(path.resolve(__dir, '../../../contracts/out/PrismP256Account.sol/PrismP256Account.json'), 'utf8'));
  }
  return _artifact;
}
function clients() {
  const chain = { id: Number(config.chain.chainId), name: 'monad', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [config.chain.rpcUrl] } } };
  const wallet = createWalletClient({ account: relayerAccount(), chain, transport: http(config.chain.rpcUrl) });
  const pub = createPublicClient({ chain, transport: http(config.chain.rpcUrl) });
  return { wallet, pub };
}

export const p256ChainOps = {
  async deployAccount({ qx, qy }) {
    const { wallet, pub } = clients();
    const hash = await wallet.deployContract({ abi: artifact().abi, bytecode: artifact().bytecode.object, args: [BigInt(qx), BigInt(qy)] });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    return receipt.contractAddress;
  },
  async relayPay({ account, token, recipient, amount, nonce, validBefore, r, s }) {
    const { wallet } = clients();
    return wallet.writeContract({
      address: account, abi: artifact().abi, functionName: 'pay',
      args: [token, recipient, BigInt(amount), nonce, BigInt(validBefore), BigInt(r), BigInt(s)]
    });
  },
  async getReceipt(hash) {
    const { pub } = clients();
    return pub.getTransactionReceipt({ hash }).catch(() => null);
  }
};
