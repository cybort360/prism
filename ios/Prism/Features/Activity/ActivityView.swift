import SwiftUI

struct ActivityView: View {
  enum Filter: String, CaseIterable {
    case all = "All"
    case sent = "Sent"
    case received = "Received"
    case requests = "Requests"
    case pending = "Pending"
  }

  @EnvironmentObject private var model: AppModel
  @State private var filter: Filter = .all
  @State private var items: [ActivityRecord] = []
  @State private var requests: [PaymentRequestRecord] = []
  @State private var claims: [ClaimRecord] = []
  @State private var showSearch = false
  @State private var query = ""
  @State private var error: String?

  var body: some View {
    VStack(spacing: 0) {
      header
      if showSearch { searchField }
      filters

      ScrollView(showsIndicators: false) {
        LazyVStack(alignment: .leading, spacing: 0) {
          if let error {
            ErrorBanner(message: error).padding(.vertical, 14)
          }

          if filtered.isEmpty {
            EmptyStateView(
              icon: "clock.arrow.circlepath",
              title: "No activity yet",
              bodyText: "Payments, requests and claim states will appear here."
            )
          }

          ForEach(grouped, id: \.0) { section, rows in
            PrismSectionLabel(text: section)
              .padding(.top, 25)
              .padding(.bottom, 8)

            ForEach(rows) { item in
              Button { open(item) } label: { row(item) }
                .buttonStyle(.plain)
              Divider().overlay(PrismTheme.line)
            }
          }
        }
        .padding(.horizontal, 22)
        .padding(.bottom, 30)
      }
      .refreshable { await load() }
    }
    .task { await load() }
    .prismScreen()
  }

  private var header: some View {
    HStack {
      Text("Activity")
        .font(PrismTheme.display(38))
        .tracking(-0.7)
      Spacer()
      PrismHeaderIconButton(icon: showSearch ? "xmark" : "magnifyingglass") {
        withAnimation(.easeOut(duration: 0.18)) {
          showSearch.toggle()
          if !showSearch { query = "" }
        }
      }
    }
    .padding(.horizontal, 22)
    .padding(.top, 12)
  }


  private var searchField: some View {
    HStack(spacing: 10) {
      Image(systemName: "magnifyingglass").foregroundStyle(PrismTheme.muted)
      TextField("Search activity", text: $query)
        .font(PrismTheme.body(14))
        .textInputAutocapitalization(.never)
      if !query.isEmpty {
        Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(PrismTheme.faint) }
          .buttonStyle(.plain)
      }
    }
    .padding(.horizontal, 14)
    .frame(height: 48)
    .background(PrismTheme.paper)
    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 16).stroke(PrismTheme.line, lineWidth: 0.6))
    .padding(.horizontal, 22)
    .padding(.top, 14)
    .transition(.move(edge: .top).combined(with: .opacity))
  }

  private var filters: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(Filter.allCases, id: \.self) { item in
          Button {
            withAnimation(.easeOut(duration: 0.16)) { filter = item }
          } label: {
            Text(item.rawValue)
              .font(PrismTheme.body(11.5, weight: .semibold))
              .foregroundStyle(filter == item ? .white : PrismTheme.ink)
              .padding(.horizontal, 15)
              .frame(height: 34)
              .background(filter == item ? PrismTheme.mintDeep : PrismTheme.paper)
              .clipShape(Capsule())
              .overlay(Capsule().stroke(filter == item ? Color.clear : PrismTheme.line, lineWidth: 0.6))
          }
          .buttonStyle(.plain)
        }
      }
      .padding(.horizontal, 22)
    }
    .padding(.top, 20)
  }

  private var filtered: [ActivityRecord] {
    items.filter { item in
      let matchesFilter: Bool
      switch filter {
      case .all: matchesFilter = true
      case .sent: matchesFilter = item.direction == "outgoing" && item.kind != "request"
      case .received: matchesFilter = item.direction == "incoming" && item.kind != "request"
      case .requests: matchesFilter = item.kind == "request"
      case .pending:
        matchesFilter = !["COMPLETED", "PAID", "DECLINED", "CANCELLED", "EXPIRED"].contains(item.status.uppercased())
      }
      guard matchesFilter else { return false }
      let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      guard !needle.isEmpty else { return true }
      let haystack = [title(item), item.memo ?? "", item.status, item.amountAtomic ?? ""]
        .joined(separator: " ").lowercased()
      return haystack.contains(needle)
    }
  }

  private var grouped: [(String, [ActivityRecord])] {
    let calendar = Calendar.current
    let groups = Dictionary(grouping: filtered) { item -> String in
      guard let date = Date.prismParse(item.createdAt) else { return "Earlier" }
      if calendar.isDateInToday(date) { return "Today" }
      if calendar.isDateInYesterday(date) { return "Yesterday" }
      return date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }
    return groups.sorted { rank($0.key) < rank($1.key) }
  }

  private func rank(_ key: String) -> Int {
    if key == "Today" { return 0 }
    if key == "Yesterday" { return 1 }
    return 2
  }

  private func row(_ item: ActivityRecord) -> some View {
    HStack(spacing: 13) {
      PrismAvatar(initials: initials(item), size: 46)

      VStack(alignment: .leading, spacing: 4) {
        Text(title(item))
          .font(PrismTheme.body(14.5, weight: .semibold))
          .foregroundStyle(PrismTheme.ink)
        Text(item.memo?.isEmpty == false ? item.memo! : subtitle(item))
          .font(PrismTheme.body(11.5))
          .foregroundStyle(PrismTheme.muted)
      }

      Spacer()

      VStack(alignment: .trailing, spacing: 4) {
        if let amount = item.amountAtomic {
          Text((item.direction == "incoming" ? "+" : "-") + Money.dollars(fromAtomic: amount))
            .font(PrismTheme.body(14, weight: .semibold))
            .foregroundStyle(item.direction == "incoming" ? PrismTheme.positive : PrismTheme.ink)
        }

        Text(item.status.replacingOccurrences(of: "_", with: " ").capitalized)
          .font(PrismTheme.body(9.5, weight: .medium))
          .foregroundStyle(statusColor(item))
      }

      Image(systemName: "chevron.right")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(PrismTheme.faint.opacity(0.7))
    }
    .padding(.vertical, 13)
  }

  private func title(_ item: ActivityRecord) -> String {
    item.counterpartyHandle
      ?? (item.kind == "request" ? "Payment request" : item.kind.replacingOccurrences(of: "-", with: " ").capitalized)
  }

  private func subtitle(_ item: ActivityRecord) -> String {
    item.kind.replacingOccurrences(of: "-", with: " ").capitalized
  }

  private func initials(_ item: ActivityRecord) -> String {
    String(title(item).replacingOccurrences(of: "@", with: "").prefix(2)).uppercased()
  }

  private func statusColor(_ item: ActivityRecord) -> Color {
    let status = item.status.uppercased()
    if ["COMPLETED", "PAID"].contains(status) { return PrismTheme.positive }
    if ["FAILED"].contains(status) { return PrismTheme.danger }
    if ["OPEN", "PENDING", "SUBMITTED", "CONFIRMING"].contains(status) { return PrismTheme.amber }
    return PrismTheme.pending
  }

  private func load() async {
    do {
      async let activityRequest = PrismAPI.shared.activity()
      async let requestRequest = PrismAPI.shared.requests()
      async let claimRequest = PrismAPI.shared.claims()
      items = try await activityRequest
      requests = try await requestRequest
      claims = try await claimRequest
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func open(_ item: ActivityRecord) {
    if let id = item.requestId, let request = requests.first(where: { $0.requestId == id }) {
      model.presentRequestDetail = RequestDetailPresentation(request: request)
      return
    }

    if let id = item.claimId, let claim = claims.first(where: { $0.claimId == id }) {
      model.presentClaimDetail = ClaimDetailPresentation(claim: claim)
      return
    }

    let amount = item.amountAtomic.map { Money.dollars(fromAtomic: $0) } ?? "—"
    model.presentReceipt = ReceiptPresentation(
      title: title(item),
      amount: amount,
      subtitle: item.memo ?? subtitle(item),
      transactionHash: item.transactionHash,
      status: item.status.replacingOccurrences(of: "_", with: " ").capitalized
    )
  }
}
