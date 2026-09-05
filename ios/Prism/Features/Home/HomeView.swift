import SwiftUI

struct HomeView: View {
  @EnvironmentObject private var model: AppModel
  @State private var balance: BalanceResponse?
  @State private var activity: [ActivityRecord] = []
  @State private var requests: [PaymentRequestRecord] = []
  @State private var claims: [ClaimRecord] = []
  @State private var localPeople: [ContactPerson] = []
  @State private var loading = false
  @State private var error: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        header.padding(.bottom, 42)
        PrismSectionLabel(text: "Total balance")
        AmountText(
          dollars: totalBalance, size: 70
        ).padding(.top, 6)
        if let metric = weeklyMetric {
          PrismMetricPill(text: metric.text, positive: metric.positive).padding(.top, 11)
        } else if loading {
          ProgressView().controlSize(.small).padding(.top, 8)
        }
        actions.padding(.top, 32).padding(.bottom, 34)
        if let request = incomingRequest { requestCard(request).padding(.bottom, 12) }
        if let claim = claims.first { claimCard(claim).padding(.bottom, 30) }
        people.padding(.bottom, 34)
        recent
        if let error { ErrorBanner(message: error).padding(.top, 18) }
      }.padding(.horizontal, 22).padding(.top, 8).padding(.bottom, 28)
    }.refreshable { await reload() }.task { await reload() }.prismScreen()
  }

  private var header: some View {
    HStack(spacing: 11) {
      PrismAvatar(initials: initials, size: 42)
      Text("Hello, \(displayName)").font(PrismTheme.body(16, weight: .semibold))
      Spacer()
      Button {
        model.selectedTab = .activity
      } label: {
        Image(systemName: "bell").font(.system(size: 17)).frame(width: 42, height: 42).background(
          PrismTheme.surface
        ).clipShape(Circle()).overlay(alignment: .topTrailing) {
          if hasAttention {
            Circle().fill(PrismTheme.mint).frame(width: 7, height: 7).offset(x: -3, y: 4)
          }
        }
      }.buttonStyle(.plain)
    }
  }
  private var displayName: String {
    if let name = model.identity?.displayName?.split(separator: " ").first { return String(name) }
    return model.identity?.handle?.replacingOccurrences(of: "@", with: "").capitalized ?? "User"
  }
  private var initials: String {
    let source: String
    if let name = model.identity?.displayName, !name.isEmpty { source = name }
    else { source = model.identity?.handle?.replacingOccurrences(of: "@", with: "") ?? "" }
    let value = source.split(separator: " ").prefix(2).compactMap { $0.first }.map(String.init).joined().uppercased()
    return value.isEmpty ? "U" : value
  }
  private var actions: some View {
    HStack(spacing: 10) {
      HomeAction(icon: "paperplane", title: "Send") { model.sendPickerPresented = true }
      HomeAction(icon: "arrow.down", title: "Request") { model.requestPickerPresented = true }
      HomeAction(icon: "qrcode.viewfinder", title: "Scan") { model.scanPresented = true }
      HomeAction(icon: "plus", title: "Add money") { model.addMoneyPresented = true }
    }
  }
  private var hasAttention: Bool { incomingRequest != nil || !claims.isEmpty }

  private var incomingRequest: PaymentRequestRecord? {
    requests.first { $0.payerPrismId == model.identity?.prismId && $0.status == "OPEN" }
  }

  private func requestCard(_ r: PaymentRequestRecord) -> some View {
    PrismCard {
      VStack(spacing: 14) {
        HStack(spacing: 12) {
          PrismAvatar(initials: "PR", size: 40)
          VStack(alignment: .leading, spacing: 3) {
            Text("Payment request").font(PrismTheme.body(11)).foregroundStyle(PrismTheme.muted)
            Text("\(Money.assetAmount(fromAtomic: r.amountAtomic)) requested").font(
              PrismTheme.body(15, weight: .semibold))
            if !r.memo.isEmpty {
              Text(r.memo).font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted)
            }
          }
          Spacer()
        }
        HStack {
          PrismSecondaryButton(title: "Decline") {
            Task {
              _ = try? await PrismAPI.shared.setRequestStatus(r.requestId, status: "DECLINED")
              await reload()
            }
          }
          PrismPrimaryButton(title: "Pay \(Money.assetAmount(fromAtomic: r.amountAtomic))") {
            Task { await openRequest(r) }
          }
        }
      }
    }
  }
  private func claimCard(_ c: ClaimRecord) -> some View {
    Button {
      model.presentClaim = c
    } label: {
      PrismCard(padding: 14) {
        HStack(spacing: 13) {
          Circle().fill(PrismTheme.mintSoft).frame(width: 42, height: 42).overlay(
            Image(systemName: "gift").foregroundStyle(PrismTheme.mintDeep))
          VStack(alignment: .leading, spacing: 3) {
            Text("You have money waiting").font(PrismTheme.body(14, weight: .semibold))
            Text("\(Money.assetAmount(fromAtomic: c.amountAtomic)) ready to claim").font(
              PrismTheme.body(12)
            ).foregroundStyle(PrismTheme.muted)
          }
          Spacer()
          Image(systemName: "chevron.right").foregroundStyle(PrismTheme.faint)
        }
      }
    }.buttonStyle(.plain)
  }
  private var people: some View {
    VStack(alignment: .leading, spacing: 15) {
      HStack {
        PrismSectionLabel(text: "People")
        Spacer()
        Button("View all") { model.selectedTab = .people }.font(
          PrismTheme.body(12, weight: .semibold)
        ).foregroundStyle(PrismTheme.teal)
      }
      if localPeople.isEmpty {
        Button { model.selectedTab = .people } label: {
          HStack(spacing: 12) {
            Circle().fill(PrismTheme.mintSoft).frame(width: 47, height: 47)
              .overlay(Image(systemName: "person.badge.plus").font(.system(size: 17, weight: .medium)).foregroundStyle(PrismTheme.mintDeep))
            VStack(alignment: .leading, spacing: 3) {
              Text("Find someone to pay").font(PrismTheme.body(13.5, weight: .semibold)).foregroundStyle(PrismTheme.ink)
              Text("Contacts or an exact @Prism handle").font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
            }
            Spacer()
            Image(systemName: "arrow.right").foregroundStyle(PrismTheme.faint)
          }
        }.buttonStyle(.plain)
      } else {
        HStack(spacing: 18) {
          ForEach(Array(localPeople.prefix(5))) { p in
            Button { model.selectedTab = .people } label: {
              VStack(spacing: 7) {
                PrismAvatar(initials: p.initials, size: 47)
                Text(p.name).font(PrismTheme.body(11)).lineLimit(1)
              }.frame(maxWidth: .infinity)
            }.buttonStyle(.plain)
          }
        }
      }
    }
  }
  private var recent: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        PrismSectionLabel(text: "Recent activity")
        Spacer()
        Button("View all") { model.selectedTab = .activity }.font(
          PrismTheme.body(12, weight: .semibold)
        ).foregroundStyle(PrismTheme.teal)
      }
      if activity.isEmpty && !loading {
        Text("Your settled payments, requests and claims will appear here.").font(
          PrismTheme.body(13)
        ).foregroundStyle(PrismTheme.muted).padding(.vertical, 16)
      } else {
        ForEach(activity.prefix(4)) {
          ActivityMiniRow(item: $0)
          Divider().overlay(PrismTheme.line)
        }
      }
    }
  }
  private var weeklyMetric: (text: String, positive: Bool)? {
    let cutoff = Date().addingTimeInterval(-7 * 24 * 60 * 60)
    var net = Decimal.zero
    var found = false
    for item in activity {
      guard let atomic = item.amountAtomic,
            let date = Date.prismParse(item.createdAt), date >= cutoff,
            let raw = Decimal(string: atomic) else { continue }
      found = true
      var divisor = Decimal(1)
      for _ in 0..<6 { divisor *= 10 }
      let amount = raw / divisor
      net += item.direction == "incoming" ? amount : -amount
    }
    guard found else { return nil }
    let magnitude = net < 0 ? -net : net
    let rendered = NSDecimalNumber(decimal: magnitude).doubleValue.formatted(
      .currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
    return ((net >= 0 ? "+" : "−") + rendered + " this week", net >= 0)
  }

  private var totalBalance: String {
    guard let balance, let raw = Decimal(string: balance.amountAtomic) else { return "$0.00" }
    var divisor = Decimal(1)
    for _ in 0..<balance.decimals { divisor *= 10 }
    let total = raw / divisor
    return NSDecimalNumber(decimal: total).doubleValue.formatted(
      .currency(code: "USD").precision(.fractionLength(2)).locale(Locale(identifier: "en_US")))
  }


  private func reload() async {
    loading = true
    defer { loading = false }
    do {
      async let b = PrismAPI.shared.balance()
      async let a = PrismAPI.shared.activity()
      async let r = PrismAPI.shared.requests()
      async let c = PrismAPI.shared.eligibleClaims()
      balance = try await b
      activity = try await a
      requests = try await r
      claims = try await c
      if let contacts = try? await ContactService.shared.contacts(), !contacts.isEmpty {
        localPeople = Array(contacts.prefix(5))
      }
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  private func openRequest(_ r: PaymentRequestRecord) async {
    do {
      let res = try await PrismAPI.shared.resolve(prismId: r.requesterPrismId)
      guard res.found else { throw APIError.server("Requester is unavailable.") }
      let contact = ContactPerson(
        id: "request:\(r.requestId)", name: r.counterpartyNameFallback, phone: nil, initials: "PR",
        prismState: .onPrism(res))
      model.presentSend = SendTarget(
        contact: contact,
        resolution: res,
        requestId: r.requestId
      )
    } catch { model.notify(error.localizedDescription) }
  }
}

private struct HomeAction: View {
  let icon, title: String
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      VStack(spacing: 9) {
        PrismIconTile(icon: icon)
        Text(title).font(PrismTheme.body(11, weight: .medium)).lineLimit(1)
      }.frame(maxWidth: .infinity)
    }.buttonStyle(.plain)
  }
}

struct ActivityMiniRow: View {
  let item: ActivityRecord
  var body: some View {
    HStack(spacing: 12) {
      PrismAvatar(initials: initials, size: 40)
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(PrismTheme.body(14, weight: .medium))
        Text(
          item.memo?.isEmpty == false
            ? item.memo! : item.kind.replacingOccurrences(of: "-", with: " ").capitalized
        ).font(PrismTheme.body(11)).foregroundStyle(PrismTheme.muted)
      }
      Spacer()
      VStack(alignment: .trailing, spacing: 3) {
        if let a = item.amountAtomic {
          Text((item.direction == "incoming" ? "+" : "-") + Money.assetAmount(fromAtomic: a)).font(
            PrismTheme.body(13, weight: .medium)
          ).foregroundStyle(item.direction == "incoming" ? PrismTheme.positive : PrismTheme.ink)
        }
        Text(item.status.replacingOccurrences(of: "_", with: " ").capitalized).font(
          PrismTheme.body(9)
        ).foregroundStyle(PrismTheme.muted)
      }
    }.padding(.vertical, 10)
  }
  private var title: String {
    item.counterpartyHandle ?? (item.kind == "request" ? "Payment request" : "Prism payment")
  }
  private var initials: String {
    String(title.replacingOccurrences(of: "@", with: "").prefix(2)).uppercased()
  }
}

extension PaymentRequestRecord {
  fileprivate var counterpartyNameFallback: String { "Prism requester" }
}
