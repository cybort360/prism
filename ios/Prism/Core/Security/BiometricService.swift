import LocalAuthentication

struct BiometricService {
  /// Returns nothing: `LAContext` is non-Sendable, so handing it back across the async boundary is
  /// a Swift 6 error, and neither caller used it — the gate is the throw, not the context.
  func authenticate(reason: String = "Approve this Prism payment") async throws {
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
      throw error ?? LAError(.biometryNotAvailable)
    }
    let ok = try await context.evaluatePolicy(
      .deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
    if !ok { throw LAError(.authenticationFailed) }
  }
}
