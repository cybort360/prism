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
    bindingProof: (nonce) =>
      account.signMessage({ message: canonicalJson({ action: 'bind_account', account: account.address.toLowerCase(), nonce }) }),
    mutation: (payload) => account.signMessage({ message: canonicalJson(payload) })
  };
}

export const PK_A = `0x${'11'.repeat(32)}`;
export const PK_B = `0x${'22'.repeat(32)}`;
export const PK_C = `0x${'33'.repeat(32)}`;

// Fetch a fresh single-use binding challenge from the service and sign it (F-07). Returns the args a
// bind endpoint expects: { account, bindingProof, challengeNonce }.
export async function bindArgs(service, owner) {
  const { nonce } = service.issueBindingChallenge();
  return { account: owner.address, bindingProof: await owner.bindingProof(nonce), challengeNonce: nonce };
}
