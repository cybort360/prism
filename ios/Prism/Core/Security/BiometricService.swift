import LocalAuthentication

struct BiometricService {
  func authenticate(reason: String = "Approve this Prism payment") async throws -> LAContext {
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
      throw error ?? LAError(.biometryNotAvailable)
    }
    let ok = try await context.evaluatePolicy(
      .deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
    if !ok { throw LAError(.authenticationFailed) }
    return context
  }
}
