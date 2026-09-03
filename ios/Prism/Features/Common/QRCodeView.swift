import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

struct QRCodeView: View {
  let text: String
  var body: some View {
    if let image = qr(text) {
      Image(uiImage: image).resizable().interpolation(.none).scaledToFit()
    } else {
      Image(systemName: "qrcode")
    }
  }
  private func qr(_ text: String) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    let transformed = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
    guard let cg = CIContext().createCGImage(transformed, from: transformed.extent) else {
      return nil
    }
    return UIImage(cgImage: cg)
  }
}
