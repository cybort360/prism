/**
 * Structured JSON logging. Never logs raw phone numbers or key material — callers pass only opaque
 * identifiers (paymentId, claimId, prismId, addresses, tx hashes).
 */
function emit(level, event, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const logger = {
  info: (event, fields = {}) => emit('info', event, fields),
  warn: (event, fields = {}) => emit('warn', event, fields),
  error: (event, fields = {}) => emit('error', event, fields)
};
