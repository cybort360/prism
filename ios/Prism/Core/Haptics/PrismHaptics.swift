import UIKit

/// UIKit's feedback generators are `@MainActor`-isolated, so the enum has to be too — under Swift 6
/// a synchronous nonisolated call into them is a hard error. Every call site is already on the main
/// actor (SwiftUI views and `@MainActor PaymentCoordinator`), so this adds no hops.
@MainActor
enum PrismHaptics {
  static func tap() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.55)
  }

  static func selection() {
    UISelectionFeedbackGenerator().selectionChanged()
  }

  static func success() {
    UINotificationFeedbackGenerator().notificationOccurred(.success)
  }

  static func warning() {
    UINotificationFeedbackGenerator().notificationOccurred(.warning)
  }

  static func error() {
    UINotificationFeedbackGenerator().notificationOccurred(.error)
  }
}
