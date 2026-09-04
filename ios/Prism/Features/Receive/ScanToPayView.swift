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
          .buttonStyle(.plain)
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
    guard let id = PrismDeepLink.prismId(from: raw) else {
      error = "That QR code is not a Prism payment link."
      return
    }

    do {
      let resolution = try await PrismAPI.shared.resolve(prismId: id)
      guard resolution.found else { throw APIError.server("This Prism account is unavailable.") }
      let contact = ContactPerson(
        id: "qr:\(id)",
        name: "Prism recipient",
        phone: nil,
        initials: "PR",
        prismState: .onPrism(resolution)
      )
      dismiss()
      model.presentSend = SendTarget(contact: contact, resolution: resolution)
    } catch {
      self.error = error.localizedDescription
    }
  }
}

enum PrismDeepLink {
  static func prismId(from raw: String) -> String? {
    guard let url = URL(string: raw) else { return nil }
    if url.scheme == "prism", url.host == "pay" { return url.pathComponents.dropFirst().first }
    if ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.pathComponents.count >= 3,
      url.pathComponents[1] == "pay"
    { return url.pathComponents[2] }
    return nil
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
