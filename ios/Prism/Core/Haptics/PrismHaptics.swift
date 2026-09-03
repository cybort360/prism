import UIKit

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
