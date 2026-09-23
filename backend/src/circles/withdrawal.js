// Pure Circle withdrawal accounting. Integer USDC base units (bigint) only — never floats.

const big = (v) => BigInt(String(v ?? '0'));

/** Net contribution per member: COMPLETED contributions minus COMPLETED withdrawals, floored at 0. */
export function netContributions(contributions = [], withdrawals = []) {
  const net = new Map();
  for (const c of contributions) {
    if (c.status !== 'COMPLETED') continue;
    net.set(c.contributorPrismId, (net.get(c.contributorPrismId) ?? 0n) + big(c.amount));
  }
  for (const w of withdrawals) {
    if (w.status !== 'COMPLETED') continue;
    net.set(w.beneficiaryPrismId, (net.get(w.beneficiaryPrismId) ?? 0n) - big(w.amount));
  }
  for (const [k, v] of net) net.set(k, v < 0n ? 0n : v);
  return net;
}

/** What a member may withdraw now: their net, capped by the live Safe balance. */
export function withdrawableFor(prismId, net, balanceAtomic) {
  const own = net.get(prismId) ?? 0n;
  const bal = big(balanceAtomic);
  return own < bal ? own : bal;
}

/** Pro-rata split of `balanceAtomic` by net contribution, largest-remainder so it sums exactly. */
export function proRataPayouts(net, balanceAtomic) {
  const balance = big(balanceAtomic);
  const entries = [...net.entries()].filter(([, v]) => v > 0n).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const total = entries.reduce((s, [, v]) => s + v, 0n);
  if (total === 0n || balance === 0n) return new Map();

  const out = new Map();
  const remainders = [];
  let assigned = 0n;
  for (const [id, share] of entries) {
    const numerator = share * balance;
    const floor = numerator / total;
    out.set(id, floor);
    assigned += floor;
    remainders.push([id, numerator % total]);
  }
  // Distribute the leftover base units to the largest remainders (ties broken by prismId order above).
  remainders.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : (a[0] < b[0] ? -1 : 1)));
  let leftover = balance - assigned;
  for (let i = 0; leftover > 0n && i < remainders.length; i++, leftover--) {
    const id = remainders[i][0];
    out.set(id, out.get(id) + 1n);
  }
  return out;
}
