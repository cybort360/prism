import AVFoundation
import SwiftUI

struct ScanToPayView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @State private var error: String?

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      QRScanner { value in Task { await route(value) } }.ignoresSafeArea()

      LinearGradient(
        colors: [Color.black.opacity(0.42), Color.clear, Color.black.opacity(0.48)],
        startPoint: .top,
        endPoint: .bottom
      )
      .ignoresSafeArea()

      VStack(spacing: 0) {
        HStack {
          Button { dismiss() } label: {
            Image(systemName: "xmark")
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(.white)
              .frame(width: 44, height: 44)
              .background(.black.opacity(0.38))
              .clipShape(Circle())
          }
          .buttonStyle(.plainHit)
          Spacer()
        }
        .padding(20)

        Spacer()

        RoundedRectangle(cornerRadius: 28, style: .continuous)
          .stroke(.white.opacity(0.92), lineWidth: 2)
          .frame(width: 260, height: 260)
          .overlay(alignment: .topLeading) { scanCorner.rotationEffect(.degrees(0)).offset(x: -2, y: -2) }
          .overlay(alignment: .topTrailing) { scanCorner.rotationEffect(.degrees(90)).offset(x: 2, y: -2) }
          .overlay(alignment: .bottomTrailing) { scanCorner.rotationEffect(.degrees(180)).offset(x: 2, y: 2) }
          .overlay(alignment: .bottomLeading) { scanCorner.rotationEffect(.degrees(270)).offset(x: -2, y: 2) }

        Spacer()

        VStack(spacing: 7) {
          Text("Scan a Prism payment QR")
            .font(PrismTheme.body(16, weight: .semibold))
            .foregroundStyle(.white)
          Text("Wallet addresses stay out of the way.")
            .font(PrismTheme.body(11.5))
            .foregroundStyle(.white.opacity(0.72))
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 13)
        .background(.black.opacity(0.42))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(.bottom, 40)
      }
    }
    .alert("Prism", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
      Button("OK") { error = nil }
    } message: {
      Text(error ?? "")
    }
  }

  private var scanCorner: some View {
    Path { path in
      path.move(to: CGPoint(x: 0, y: 24))
      path.addLine(to: CGPoint(x: 0, y: 0))
      path.addLine(to: CGPoint(x: 24, y: 0))
    }
    .stroke(PrismTheme.mint, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
    .frame(width: 24, height: 24)
  }

  private func route(_ raw: String) async {
    // Resolve through the shared recipient resolver, then open the Send review — never instant send.
    if let message = await model.openPaymentLink(raw, entryMethod: .qr) {
      error = message
    } else {
      dismiss()
    }
  }
}

/// A parsed Prism recipient link. Carries what a link/QR can safely say: which identity to resolve
/// (opaque prismId or pretty @handle) and OPTIONAL amount/reference. The amount and reference only
/// ever pre-fill a review the payer must still approve — an unsigned URL parameter can never mutate a
/// signed payment (section 4).
struct PrismLink: Equatable {
  var prismId: String? = nil
  var handle: String? = nil
  /// Decimal dollars (e.g. "20", "20.00"). Prefill only.
  var amount: String? = nil
  /// A display-only reference/note. Never affects signing.
  var reference: String? = nil
}

enum PrismDeepLink {
  /// Reserved path words that are routes, not handles.
  private static let reserved: Set<String> = ["pay", "u", "claim", "request", "r"]

  /// Back-compat accessor for callers that only need the opaque id.
  static func prismId(from raw: String) -> String? { parse(raw)?.prismId }

  /// The one parser. Every recipient surface (QR scan, universal link, shared payment link) flows
  /// through this, so they share identical resolution semantics — no separate identity meaning.
  static func parse(_ raw: String) -> PrismLink? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let comps = URLComponents(string: trimmed) else { return nil }
    let scheme = comps.scheme?.lowercased()
    let parts = comps.path.split(separator: "/").map(String.init).filter { !$0.isEmpty }
    let q = Dictionary((comps.queryItems ?? []).compactMap { item in item.value.map { (item.name.lowercased(), $0) } }, uniquingKeysWith: { a, _ in a })
    let amount = normalizedAmount(q["amount"])
    let ref = q["ref"] ?? q["reference"]

    // prism://pay/<id>  (opaque prismId — the personal QR form)
    if scheme == "prism", comps.host == "pay", let id = parts.first {
      return PrismLink(prismId: id, amount: amount, reference: ref)
    }
    // prism://u/<handle>
    if scheme == "prism", comps.host == "u", let h = parts.first, let handle = handleIfValid(h) {
      return PrismLink(handle: handle, amount: amount, reference: ref)
    }
    if scheme == "http" || scheme == "https" {
      // https://<host>/pay/<id>
      if parts.count >= 2, parts[0] == "pay" {
        return PrismLink(prismId: parts[1], amount: amount, reference: ref)
      }
      // Pretty: https://app.getprism.xyz/<handle>  (single non-reserved segment)
      if parts.count == 1, let handle = handleIfValid(parts[0]) {
        return PrismLink(handle: handle, amount: amount, reference: ref)
      }
    }
    return nil
  }

  private static func handleIfValid(_ raw: String) -> String? {
    let h = raw.hasPrefix("@") ? String(raw.dropFirst()) : raw
    guard h.count >= 2, !reserved.contains(h.lowercased()),
      h.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." }) else { return nil }
    return h
  }
  private static func normalizedAmount(_ raw: String?) -> String? {
    guard let raw, let d = Decimal(string: raw.replacingOccurrences(of: ",", with: "")), d > 0 else { return nil }
    return raw
  }
}

struct QRScanner: UIViewControllerRepresentable {
  let onCode: (String) -> Void
  func makeUIViewController(context: Context) -> ScannerController {
    let controller = ScannerController()
    controller.onCode = onCode
    return controller
  }
  func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  var onCode: ((String) -> Void)?
  private let session = AVCaptureSession()
  private var delivered = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    guard let device = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input)
    else { return }
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else { return }
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    let preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill
    preview.frame = view.bounds
    view.layer.addSublayer(preview)
    // startRunning() blocks, so it must not run on the main actor. AVCaptureSession is not Sendable
    // and `session` is main-actor isolated, so hand the background queue an explicitly unsafe local
    // rather than reaching back through `self`. AVFoundation documents this call as safe off-main.
    nonisolated(unsafe) let capture = session
    DispatchQueue.global(qos: .userInitiated).async { capture.startRunning() }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    (view.layer.sublayers?.first as? AVCaptureVideoPreviewLayer)?.frame = view.bounds
  }

  nonisolated func metadataOutput(
    _ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard let code = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
    else { return }
    Task { @MainActor in
      guard !self.delivered else { return }
      self.delivered = true
      self.session.stopRunning()
      self.onCode?(code)
    }
  }
}
