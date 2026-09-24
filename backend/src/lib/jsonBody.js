// Serialize an HTTP response body. BigInt is coerced to a decimal string — the same wire shape the
// payment flow already uses for uint256 typed-data fields (see paymentService `serialize`), so a
// signed authorization stays byte-compatible whether it comes back from payments or from a demo
// quote/sweep. Throws on circular references; the HTTP `send()` wraps this in try/catch and returns a
// clean 500 rather than letting a serialization failure crash the process via a double-send.
export function jsonBody(object) {
  return JSON.stringify(object, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
}
