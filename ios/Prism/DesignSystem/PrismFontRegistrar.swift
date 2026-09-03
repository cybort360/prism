import CoreText
import Foundation

/// Registers custom font files bundled under Resources/Fonts without requiring a hard-coded UIAppFonts filename.
/// This keeps PRISM ready for the F5.6 licensed file while allowing source distribution without the font binary.
enum PrismFontRegistrar {
  static func registerBundledFonts() {
    let extensions = ["otf", "ttf"]
    for ext in extensions {
      guard let urls = Bundle.main.urls(forResourcesWithExtension: ext, subdirectory: "Fonts") else { continue }
      for url in urls {
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
      }
    }
  }
}
