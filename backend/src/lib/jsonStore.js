import fs from 'node:fs';
import path from 'node:path';

const EMPTY = {
  identities: {},
  phoneIndex: {},
  handleIndex: {},
  requests: {},
  claims: {},
  operations: {},
  trustedRecipients: {},
  rateLimits: {},
  serviceKeys: {},
  // Prism Circles. `circles` holds the human layer only — authority and balance are read from Monad
  // (see src/circles/model.js CANONICAL_SOURCES). `circleSalts` maps a Circle's deterministic salt
  // to its id, which is what makes a repeated creation request idempotent rather than a second Safe.
  circles: {},
  circleSalts: {},
  circleMembers: {},
  circleInvitations: {},
  circleProposals: {},
  circleApprovals: {},
  circleContributions: {},
  circleWithdrawals: {},
  circleClosePlans: {}
};

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify(EMPTY, null, 2), { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch {}
  }

  read() {
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    return { ...structuredClone(EMPTY), ...parsed };
  }

  write(data) {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch {}
  }

  mutate(fn) {
    const data = this.read();
    const result = fn(data);
    this.write(data);
    return result;
  }
}
