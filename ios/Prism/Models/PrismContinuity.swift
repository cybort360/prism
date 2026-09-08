import Foundation

// PRISM Continuity, client side — mirrors backend/src/lib/continuity.js so the two never drift. Keeps
// reachability separate from identity: a mutable alias can never silently change WHO gets paid.
//
// Vocabulary (each decoupled from the one above):
//   PrismIdentity          persistent { prismId } — WHO the recipient is.
//   ReachabilityAlias      phone / @handle / QR / link — HOW they are found (a mutable route, not a key).
//   AliasBinding           the (alias -> PrismIdentity) mapping the resolver holds.
//   AliasVersion           a counter bumped on any authenticated alias/account mutation.
//   ResolutionAttestation  the resolver's SIGNED statement (prismIdentity, recipientAccount, aliasVersion,
//                          requesterPrismId, requestId, issuedAt, expiresAt).
//   KnownRecipientBinding  what the PAYER last trusted for a local contact: { prismId, account, aliasVersion }.
//   DeviceCredential       the payer's device passkey (root of spending authority) — not part of a resolution.
//   PrismAccount           the recipient's on-chain account (recipientAccount) — WHERE money lives.

enum PrismContinuityState: String, Equatable {
  case firstContact                     // A — no prior trusted PrismIdentity for this contact
  case continuityMatch                  // B — same PrismIdentity; may proceed after normal checks
  case identityDiscontinuity            // C — now a DIFFERENT PrismIdentity; must not silently proceed
  case staleResolution                  // D — attestation no longer valid; fail closed, re-resolve
  case resolverUnavailableOrAmbiguous   // E — do not guess, do not use stale fallback
}

/// What the payer last trusted for a local contact. Persisted (survives relaunch) so continuity is not
/// lost across launches. Deliberately carries only opaque ids + the account — never a phone value.
struct KnownRecipientBinding: Codable, Equatable {
  let prismId: String
  let account: String
  let aliasVersion: Int
}

enum PrismContinuity {
  /// Classify a fresh resolution against what the payer previously trusted. Deterministic; verification
  /// and freshness are checked BEFORE identity, so a stale/expired/ambiguous resolution never
  /// masquerades as a match. `currentAliasVersion` is usually unknown on the client (nil) — the backend
  /// enforces live-version staleness at settlement (`assertResolution`).
  static func classify(
    known: KnownRecipientBinding?,
    resolution: ResolutionResponse,
    now: Date = Date(),
    signatureValid: Bool = true,
    currentAliasVersion: Int? = nil,
    ambiguous: Bool = false
  ) -> PrismContinuityState {
    // E — the resolver could not give a single confident answer.
    guard resolution.found, !ambiguous, let a = resolution.attestation else { return .resolverUnavailableOrAmbiguous }

    // D — a resolution we cannot trust as CURRENT fails closed.
    if !signatureValid { return .staleResolution }
    guard let expires = parseISO(a.expiresAt) else { return .staleResolution } // unparseable → fail closed
    if expires <= now { return .staleResolution }
    if let current = currentAliasVersion, a.aliasVersion != current { return .staleResolution } // superseded / revoked

    // A — nothing previously trusted.
    guard let known else { return .firstContact }

    // C — a DIFFERENT PrismIdentity behind the known alias (a different human). Never silent.
    if known.prismId.lowercased() != a.prismIdentity.lowercased() { return .identityDiscontinuity }

    // Same PrismIdentity — NOT a different human.
    if known.account.lowercased() == a.recipientAccount.lowercased() { return .continuityMatch } // B (account unchanged)
    // Same identity, different active account = an account ROTATION. Accept only with an authenticated
    // (advancing) AliasVersion; an account swap with no version advance is anomalous — do not proceed.
    if a.aliasVersion > known.aliasVersion { return .continuityMatch } // B (authenticated account rotation)
    return .resolverUnavailableOrAmbiguous
  }

  /// Robust ISO-8601 parse (the resolver emits fractional seconds).
  static func parseISO(_ s: String) -> Date? {
    let withFrac = ISO8601DateFormatter()
    withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = withFrac.date(from: s) { return d }
    return ISO8601DateFormatter().date(from: s)
  }
}
