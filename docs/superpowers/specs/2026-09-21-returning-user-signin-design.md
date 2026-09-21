# Returning-user Sign-in on the onboarding story

**Date:** 2026-09-21
**Status:** Approved (design)
**Branch:** `integrate/universal-payments`

## Problem

After `AppModel.signOut()`, the app clears the session and `onboarding.complete`, so
`PrismApp` routes back to `OnboardingFlow` starting at `.story` — the **new-user** marketing
flow. A returning user who signed out therefore sees no acknowledgment that they already have
an account and no fast path back in, even though the device still holds the Secure Enclave /
software P-256 credential that can recover the same account in one Face ID tap.

There is **no server-side password login** in Prism: the device P-256 key *is* the account
authority. "Sign in" on this device means "re-bind the persisted key and restore the session",
which the backend already treats idempotently (`createDeviceIdentity` returns the existing
identity for a known account).

## Goal

Add a visible returning-user sign-in affordance to the onboarding story that:
- appears **only** when this device already holds a Prism credential;
- requires a local approval (Face ID, PIN fallback) before restoring the session;
- recovers the **same** account and lands the user straight on Home.

Non-goals: new-device account recovery (no credential to re-derive from), multi-account switching,
any server-side credential login.

## Design

### 1. Detecting a returning device
`DeviceP256CredentialStore.hasStoredCredential: Bool` — returns true if the Keychain holds either
`prism.p256.secureEnclave` or `prism.p256.software`, **without creating** a key (distinct from
`loadOrCreate()`). `AppModel.deviceHasAccount` exposes it to the view layer.

### 2. UI — `StoryStep`
A secondary text button **"Already have an account? Sign in"** beneath the primary CTA, shown on
all story pages when `deviceHasAccount == true`. `StoryStep` gains a `signIn: () -> Void` closure
alongside its existing `next`. Hidden entirely on fresh devices.

### 3. Sign-in action — `OnboardingFlow.signInReturning()`
1. **Local approval** (reuses the payments gate): if Face ID is enabled →
   `BiometricService().authenticate(reason: "Sign in to Prism")`; otherwise present the existing
   `PINAuthorizationSheet` → `PINService.shared.verify(pin)` (existing attempt-lockout applies).
2. On approval → `PrismAPI.shared.createDeviceIdentity()` — signs a fresh `/v1/auth/challenge`
   nonce with the persisted key; backend recognizes the existing account and returns the same
   identity + a new session (stored in Keychain).
3. `model.authenticated(auth)` → `model.finishOnboarding()` → `MainShell` (Home). Reachability,
   handle, and PIN setup are skipped (already configured; PIN + Face ID preference persist across
   sign-out).

### 4. Error handling
- Biometric cancel → return to the story silently (no error surface).
- Real failure (network, unreadable credential) → inline message under the button; "Get started"
  remains available; retry allowed.
- Wrong PIN → handled by `PINService` lockout.

### 5. Testing
- **Unit:** `DeviceP256CredentialStore.hasStoredCredential` is false on a clean Keychain, true
  after `loadOrCreate()`.
- **Live round-trip** (running simulator + dev backend): onboard → sign out → "Sign in" → assert
  the **same `prismId`** returns.
- Backend idempotency of `createDeviceIdentity` is already covered by existing tests.

## Files touched
- `ios/Prism/Core/Security/DeviceP256Credential.swift` — add `hasStoredCredential`.
- `ios/Prism/App/AppModel.swift` — add `deviceHasAccount`.
- `ios/Prism/Features/Onboarding/OnboardingFlow.swift` — `StoryStep` secondary button +
  `signInReturning()` + local-approval sheet state.
- `ios/PrismTests/…` — `hasStoredCredential` unit test.
