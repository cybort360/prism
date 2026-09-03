import SwiftUI

@main
struct PrismApp: App {
  @StateObject private var model = AppModel()

  init() {
    PrismFontRegistrar.registerBundledFonts()
  }
  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(model)
        .preferredColorScheme(.light)
        .task { await model.bootstrap() }
    }
  }
}

struct RootView: View {
  @EnvironmentObject var model: AppModel
  var body: some View {
    Group {
      if model.isBooting {
        ZStack {
          PrismTheme.canvas.ignoresSafeArea()
          ProgressView().tint(PrismTheme.mint)
        }
      } else if model.identity == nil || !model.onboardingComplete {
        OnboardingFlow()
      } else {
        MainShell()
      }
    }
    .animation(.easeInOut(duration: 0.24), value: model.identity?.prismId)
  }
}

struct MainShell: View {
  @EnvironmentObject var model: AppModel
  var body: some View {
    VStack(spacing: 0) {
      Group {
        switch model.selectedTab {
        case .home: HomeView()
        case .people: PeopleView()
        case .activity: ActivityView()
        case .profile: ProfileView()
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      PrismTabBar(selection: $model.selectedTab)
    }
    .prismScreen()
    .sheet(item: $model.presentSend) { target in SendMoneyView(target: target) }
    .sheet(item: $model.presentRequest) { target in RequestMoneyView(target: target) }
    .sheet(item: $model.presentUnregistered) { contact in UnregisteredSendView(contact: contact) }
    .sheet(item: $model.presentClaim) { claim in ClaimMoneyView(claim: claim) }
    .sheet(item: $model.presentReceipt) { receipt in ReceiptView(receipt: receipt) }
    .sheet(item: $model.presentIdentityChange) { candidate in
      IdentityChangeReviewView(candidate: candidate)
    }
    .sheet(item: $model.presentClaimDetail) { item in ClaimDetailView(claim: item.claim) }
    .sheet(item: $model.presentRequestDetail) { item in RequestDetailView(request: item.request) }
    .sheet(isPresented: $model.sendPickerPresented) { PersonPickerView(mode: .send) }
    .sheet(isPresented: $model.requestPickerPresented) { PersonPickerView(mode: .request) }
    .sheet(isPresented: $model.addMoneyPresented) { AddMoneyView() }
    .sheet(isPresented: $model.receivePresented) { ReceiveView() }
    .fullScreenCover(isPresented: $model.scanPresented) { ScanToPayView() }
    .onOpenURL { url in Task { await routeDeepLink(url) } }
    .overlay(alignment: .top) {
      if let toast = model.toast {
        Text(toast).font(PrismTheme.body(14, weight: .semibold)).padding(.horizontal, 16).padding(
          .vertical, 11
        )
        .background(.thinMaterial).clipShape(Capsule()).padding(.top, 12).transition(
          .move(edge: .top).combined(with: .opacity))
      }
    }
  }
  private func routeDeepLink(_ url: URL) async {
    guard let prismId = PrismDeepLink.prismId(from: url.absoluteString) else { return }
    do {
      let resolution = try await PrismAPI.shared.resolve(prismId: prismId)
      guard resolution.found else { throw APIError.server("This Prism account is unavailable.") }
      let contact = ContactPerson(
        id: "link:\(prismId)", name: "Prism recipient", phone: nil, initials: "PR",
        prismState: .onPrism(resolution))
      model.presentSend = SendTarget(contact: contact, resolution: resolution)
    } catch { model.notify(error.localizedDescription) }
  }

}
