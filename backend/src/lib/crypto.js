import crypto from 'node:crypto';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64url = (s) => Buffer.from(s, 'base64url');
export const hex = (buf) => `0x${Buffer.from(buf).toString('hex')}`;
export const fromHex = (s) => Buffer.from(s.replace(/^0x/, ''), 'hex');
export const randomHex = (bytes = 32) => hex(crypto.randomBytes(bytes));
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
export const hmac256 = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

export function normalizeE164(input) {
  const value = String(input).trim().replace(/[\s()-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(value)) throw new Error('phone must be E.164');
  return value;
}

export function phoneLookupKey(phone, pepper) {
  return hex(hmac256(pepper, normalizeE164(phone)));
}

export function encryptString(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: b64url(iv), ciphertext: b64url(ciphertext), tag: b64url(tag) };
}

export function decryptString(blob, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, fromB64url(blob.iv));
  decipher.setAuthTag(fromB64url(blob.tag));
  return Buffer.concat([decipher.update(fromB64url(blob.ciphertext)), decipher.final()]).toString('utf8');
}

export function issueSession(payload, secret, ttlSeconds = 60 * 60 * 24 * 30) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = b64url(Buffer.from(JSON.stringify(body)));
  const sig = b64url(hmac256(secret, encoded));
  return `${encoded}.${sig}`;
}

/**
 * A session failure is 401, not 400.
 *
 * The distinction is not cosmetic: 400 tells a client its request was malformed, and a client that
 * believes that will not re-authenticate. Found by the Circles route audit, which expected every
 * authenticated route to answer an unauthenticated caller with 401 and found them all answering
 * 400 — access was correctly denied throughout, but for the wrong stated reason.
 */
function unauthorized(message) {
  const e = new Error(message);
  e.statusCode = 401;
  return e;
}

export function verifySession(token, secret) {
  if (!token) throw unauthorized('missing session');
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) throw unauthorized('invalid session');
  const expected = hmac256(secret, encoded);
  const actual = fromB64url(sig);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw unauthorized('invalid session');
  const body = JSON.parse(fromB64url(encoded).toString('utf8'));
  if (body.exp < Math.floor(Date.now() / 1000)) throw unauthorized('session expired');
  return body;
}

export function generateP256KeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    qx: hex(fromB64url(jwk.x)),
    qy: hex(fromB64url(jwk.y))
  };
}

export function p256SignData(privateKeyPem, data) {
  return crypto.sign('sha256', Buffer.from(data), {
    key: privateKeyPem,
    dsaEncoding: 'ieee-p1363'
  });
}

export function p256VerifyData(publicKeyPem, data, signature) {
  return crypto.verify('sha256', Buffer.from(data), {
    key: publicKeyPem,
    dsaEncoding: 'ieee-p1363'
  }, Buffer.from(signature));
}

export function p256PublicKeyFromXY(qxHex, qyHex) {
  const x = b64url(fromHex(qxHex));
  const y = b64url(fromHex(qyHex));
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' });
}

export function verifyDeviceSignature({ qx, qy }, data, signatureHex) {
  const key = p256PublicKeyFromXY(qx, qy);
  return crypto.verify('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }, fromHex(signatureHex));
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
