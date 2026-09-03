import SwiftUI
import UIKit

enum PrismTheme {
  // PRISM V1 visual system — tuned to the approved premium fintech reference.
  // Cool paper, charcoal ink, restrained mint/teal signal color, minimal chrome.
  static let canvas = Color(red: 0.969, green: 0.976, blue: 0.973)       // #F7F9F8
  static let paper = Color.white
  static let ink = Color(red: 0.055, green: 0.075, blue: 0.071)          // #0E1312
  static let muted = Color(red: 0.39, green: 0.43, blue: 0.42)           // #646E6B
  static let faint = Color(red: 0.63, green: 0.67, blue: 0.65)           // #A1AAA6
  static let line = Color(red: 0.89, green: 0.92, blue: 0.91)            // #E3EAE7
  static let surface = Color.white
  static let surfaceRaised = Color.white

  // Cooler than the original green. This is the single strong brand signal.
  static let mint = Color(red: 0.39, green: 0.79, blue: 0.70)            // #64C9B3
  static let mintDeep = Color(red: 0.045, green: 0.34, blue: 0.30)       // #0C574C
  static let mintSoft = Color(red: 0.91, green: 0.975, blue: 0.958)      // #E8F9F4
  static let teal = Color(red: 0.075, green: 0.43, blue: 0.38)
  static let midnight = Color(red: 0.055, green: 0.12, blue: 0.11)

  // Secondary tones are intentionally quiet and used mainly for avatars/status differentiation.
  static let ice = Color(red: 0.90, green: 0.95, blue: 0.98)
  static let lavender = Color(red: 0.94, green: 0.92, blue: 0.98)
  static let rose = Color(red: 0.98, green: 0.92, blue: 0.93)
  static let sand = Color(red: 0.97, green: 0.94, blue: 0.88)
  static let sky = Color(red: 0.91, green: 0.95, blue: 0.99)

  static let amber = Color(red: 0.75, green: 0.49, blue: 0.13)
  static let danger = Color(red: 0.70, green: 0.23, blue: 0.20)
  static let pending = Color(red: 0.34, green: 0.43, blue: 0.50)

  static func display(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
    // F5.6 is the brand/display face. The binary is intentionally not embedded in source;
    // add your licensed/OFL copy to the target as described in Resources/FONT_SETUP.md.
    for name in ["F5.6", "F5.6-Regular", "F5_6"] where UIFont(name: name, size: size) != nil {
      return .custom(name, size: size)
    }
    return .system(size: size, weight: weight, design: .rounded)
  }

  static func body(_ size: CGFloat = 16, weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .default)
  }

  static func mono(_ size: CGFloat = 12, weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .monospaced)
  }
}

extension View {
  func prismScreen() -> some View {
    background(PrismTheme.canvas.ignoresSafeArea()).foregroundStyle(PrismTheme.ink)
  }

  func prismCardShadow() -> some View {
    shadow(color: PrismTheme.midnight.opacity(0.045), radius: 18, x: 0, y: 7)
  }
}

extension PrismTheme {
  static let softMint = mintSoft
  static let positive = mintDeep
  static let coolBlue = pending
}
