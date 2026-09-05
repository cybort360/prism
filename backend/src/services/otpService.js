import { normalizeE164, phoneLookupKey } from '../lib/crypto.js';
import { consumeRateLimit } from '../lib/rateLimit.js';

export class OtpService {
  constructor({ config, store }) {
    this.config = config;
    this.store = store;
    // Explicit provider when set; otherwise derive from Twilio presence (dev when absent). The real
    // config sets `otpProvider` and assertSafeConfig fails a prod boot that isn't 'twilio'.
    this.provider = config.otpProvider ?? (config.twilio?.accountSid ? 'twilio' : 'dev');
  }

  // Defense in depth: even if config validation is bypassed, the dev OTP path can never run in
  // production. assertSafeConfig already fails the boot, so this should be unreachable there.
  _assertDevAllowed() {
    if (this.config.nodeEnv === 'production') throw new Error('dev OTP is disabled in production');
  }

  async start(phone, requesterKey = 'unknown') {
    phone = normalizeE164(phone);
    consumeRateLimit(this.store, `otp-start:${requesterKey}`, { limit: 8, windowMs: 60 * 60_000 });
    // The per-phone throttle is keyed by the peppered HMAC, never the raw E.164 — this key is
    // persisted in the datastore, and a raw number here would be plaintext PII at rest.
    consumeRateLimit(this.store, `otp-phone:${phoneLookupKey(phone, this.config.resolverPepper)}`, { limit: 5, windowMs: 60 * 60_000 });

    if (this.provider === 'dev') { this._assertDevAllowed(); return { status: 'pending', channel: 'dev' }; }
    const url = `https://verify.twilio.com/v2/Services/${this.config.twilio.verifyServiceSid}/Verifications`;
    const body = new URLSearchParams({ To: phone, Channel: 'sms' });
    const auth = Buffer.from(`${this.config.twilio.accountSid}:${this.config.twilio.authToken}`).toString('base64');
    const res = await fetch(url, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) throw new Error(`Twilio start failed: ${res.status}`);
    const json = await res.json();
    return { status: json.status, channel: 'sms', sid: json.sid };
  }

  async check(phone, code, requesterKey = 'unknown') {
    phone = normalizeE164(phone);
    consumeRateLimit(this.store, `otp-check:${requesterKey}`, { limit: 12, windowMs: 60 * 60_000 });
    if (this.provider === 'dev') { this._assertDevAllowed(); return { approved: String(code) === this.config.devOtpCode }; }

    const url = `https://verify.twilio.com/v2/Services/${this.config.twilio.verifyServiceSid}/VerificationCheck`;
    const body = new URLSearchParams({ To: phone, Code: String(code) });
    const auth = Buffer.from(`${this.config.twilio.accountSid}:${this.config.twilio.authToken}`).toString('base64');
    const res = await fetch(url, { method: 'POST', headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) throw new Error(`Twilio check failed: ${res.status}`);
    const json = await res.json();
    return { approved: json.status === 'approved', status: json.status };
  }
}
