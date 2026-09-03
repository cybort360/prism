import { privateKeyToAccount } from 'viem/accounts';
import { canonicalJson } from '../src/lib/crypto.js';

// Simulates a Mera passkey-derived secp256k1 account for tests: the same standard-ECDSA signer
// the real Mera library produces, exercised through viem.
export function meraAccount(pkHex) {
  const account = privateKeyToAccount(pkHex);
  return {
    address: account.address,
    account,
    signMessage: (message) => account.signMessage({ message }),
    signTypedData: (typed) => account.signTypedData(typed),
    bindingProof: () =>
      account.signMessage({ message: canonicalJson({ action: 'bind_account', account: account.address.toLowerCase() }) }),
    mutation: (payload) => account.signMessage({ message: canonicalJson(payload) })
  };
}

export const PK_A = `0x${'11'.repeat(32)}`;
export const PK_B = `0x${'22'.repeat(32)}`;
export const PK_C = `0x${'33'.repeat(32)}`;
