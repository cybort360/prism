// Thin client over the Prism backend's public + cross-chain-pay routes (unauthenticated).
const BASE = import.meta.env.VITE_API_BASE_URL as string;

async function post(path: string, body: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${r.status}`);
  return json;
}

export type PublicRequest = {
  requestId: string;
  requesterHandle: string | null;
  requesterDisplayName: string | null;
  requesterAccount: string | null;
  amountAtomic: string;
  token: string;
  tokenSymbol: string | null;
  memo: string;
  destination: string;
  status: string;
  expiresAt: string;
};

export type QuoteResult = {
  requestId: string;
  amountAtomic: string;
  destinationChain: string;
  requester: { handle: string | null; account: string };
  route: { amountIn?: string; amountInFormatted?: string; timeEstimate?: number; [k: string]: unknown };
  preview: boolean;
};

export type FulfillResult = {
  status: string;
  deliveryTxHash: string;
  destination: string;
  sweep: { state: string } | null;
};

export const getPublicRequest = (id: string): Promise<PublicRequest> =>
  fetch(`${BASE}/v1/requests/${id}/public`).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

export const quote = (
  id: string,
  body: { payerAddress: string; sourceChain: string; sourceAsset: string }
): Promise<QuoteResult> => post(`/v1/pay/${id}/quote`, body);

export const fulfill = (
  id: string,
  body: { payerAddress: string; sourceChain: string; signature: string }
): Promise<FulfillResult> => post(`/v1/pay/${id}/fulfill`, body);
