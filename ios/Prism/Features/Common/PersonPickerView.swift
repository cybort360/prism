import SwiftUI
import UIKit

enum PersonPickerMode: Equatable {
  case send, request
  /// Paying *from* a Circle. The recipient is resolved through the same Protected Alias Resolver as
  /// a personal payment — that is the whole point, and it is what gives a Circle payment the same
  /// continuity guarantees. Only the destination screen differs.
  case circlePay(circleId: String, circleName: String)

  var isPaying: Bool { if case .request = self { return false }; return true }

  var title: String {
    switch self {
    case .send: return "Send money"
    case .request: return "Request money"
    case .circlePay(_, let name): return "Pay from \(name)"
    }
  }

  var subtitle: String {
    switch self {
    case .send: return "Choose who you want to pay"
    case .request: return "Choose who to request from"
    case .circlePay: return "Choose who the Circle is paying"
    }
  }
}

struct PersonPickerView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let mode: PersonPickerMode
  @AppStorage("feature.crossChainSend") private var crossChainEnabled = false
  @State private var contacts: [ContactPerson] = []
  @State private var query = ""
  @State private var busyId: String?
  @State private var error: String?
  @State private var contactsBlocked = false
  @State private var loading = true

  var body: some View {
    VStack(spacing: 0) {
      PrismSheetHeader(title: mode.title, subtitle: mode.subtitle, close: { dismiss() })

      HStack(spacing: 11) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(PrismTheme.muted)
        TextField("Search contacts or @handle", text: $query)
          .font(PrismTheme.body(14))
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        if !query.isEmpty {
          Button { query = "" } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(PrismTheme.faint)
          }
          .buttonStyle(.plain)
        }
      }
      .padding(.horizontal, 15)
      .frame(height: 50)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 17).stroke(PrismTheme.line, lineWidth: 0.6))
      .padding(.horizontal, 28)
      .padding(.top, 22)

      ScrollView(showsIndicators: false) {
        LazyVStack(alignment: .leading, spacing: 0) {
          // Paying someone on another network is still "send money", so it belongs here rather than
          // behind a separate entry point the user has to know exists. Hidden for everyday users:
          // it's a cross-chain (web3) surface, shown only when enabled in Settings.
          if mode == .send && crossChainEnabled {
            Button {
              dismiss()
              model.sendAnywherePresented = true
            } label: {
              HStack(spacing: 12) {
                PrismIconTile(icon: "globe")
                VStack(alignment: .leading, spacing: 3) {
                  Text("Send to another network")
                    .font(PrismTheme.body(15, weight: .semibold))
                    .foregroundStyle(PrismTheme.ink)
                  Text("Any chain, any token, to a wallet address")
                    .font(PrismTheme.body(11.5))
                    .foregroundStyle(PrismTheme.muted)
                }
                Spacer()
                Image(systemName: "chevron.right")
                  .font(.system(size: 12, weight: .semibold))
                  .foregroundStyle(PrismTheme.faint)
              }
              .padding(.vertical, 14)
            }
            .buttonStyle(.plain)
            .padding(.top, 14)

            Divider().overlay(PrismTheme.line)
          }

          PrismSectionLabel(text: query.hasPrefix("@") ? "Handle" : "Contacts")
            .padding(.top, 20)
            .padding(.bottom, 8)

          if query.hasPrefix("@") && query.count > 1 {
            Button { Task { await resolveHandle(query) } } label: {
              HStack(spacing: 14) {
                PrismAvatar(initials: "@", size: 46, tone: PrismTheme.mintSoft)
                VStack(alignment: .leading, spacing: 3) {
                  Text(query.lowercased())
                    .font(PrismTheme.body(15, weight: .semibold))
                    .foregroundStyle(PrismTheme.ink)
                  Text("Exact Prism handle")
                    .font(PrismTheme.body(11.5))
                    .foregroundStyle(PrismTheme.muted)
                }
                Spacer()
                if busyId == "handle" {
                  ProgressView().controlSize(.small).tint(PrismTheme.mintDeep)
                } else {
                  Image(systemName: "arrow.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(PrismTheme.muted)
                }
              }
              .padding(.vertical, 13)
            }
            .buttonStyle(.plain)
            Divider().overlay(PrismTheme.line)
          }

          ForEach(filteredContacts) { contact in
            Button { Task { await choose(contact) } } label: {
              HStack(spacing: 14) {
                PrismAvatar(initials: contact.initials, size: 46)
                VStack(alignment: .leading, spacing: 3) {
                  Text(contact.name)
                    .font(PrismTheme.body(14.5, weight: .semibold))
                    .foregroundStyle(PrismTheme.ink)
                  Text(contact.handle ?? masked(contact.phone))
                    .font(PrismTheme.body(11.5))
                    .foregroundStyle(PrismTheme.muted)
                }
                Spacer()
                if busyId == contact.id {
                  ProgressView().controlSize(.small).tint(PrismTheme.mintDeep)
                } else {
                  Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(PrismTheme.faint)
                }
              }
              .padding(.vertical, 13)
            }
            .buttonStyle(.plain)
            Divider().overlay(PrismTheme.line)
          }

          if loading && contacts.isEmpty && !query.hasPrefix("@") {
            ProgressView().tint(PrismTheme.mintDeep).frame(maxWidth: .infinity).padding(.top, 30)
          } else if !loading && filteredContacts.isEmpty && !query.hasPrefix("@") {
            contactsFallback.padding(.top, 18)
          }
        }
        .padding(.horizontal, 28)
        .padding(.bottom, 28)
      }
    }
    .prismScreen()
    .task { await loadContacts() }
    .alert("Prism", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
      Button("OK") { error = nil }
    } message: {
      Text(error ?? "")
    }
  }

  /// Shown when there are no matching contacts — most importantly when Contacts access is off. The
  /// @handle path above is always available, so contact permission is never a dead end.
  private var contactsFallback: some View {
    VStack(spacing: 12) {
      ZStack {
        Circle().fill(PrismTheme.mintSoft).frame(width: 56, height: 56)
        Image(systemName: contactsBlocked ? "at" : "person.crop.circle.badge.questionmark")
          .font(.system(size: 22, weight: .medium)).foregroundStyle(PrismTheme.mintDeep)
      }
      Text(contactsBlocked ? "Search a @handle to pay" : (query.isEmpty ? "No contacts with a number" : "No matches"))
        .font(PrismTheme.body(15, weight: .semibold)).foregroundStyle(PrismTheme.ink)
      Text(contactsBlocked
        ? "Contacts access is off. Type someone’s @handle above to pay them. You don’t need your contacts."
        : "Type a @handle above to pay anyone on Prism.")
        .font(PrismTheme.body(12.5)).foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.center).lineSpacing(2)
        .padding(.horizontal, 20)
      if contactsBlocked {
        Button("Turn on Contacts in Settings") {
          if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        }
        .font(PrismTheme.body(13, weight: .semibold)).foregroundStyle(PrismTheme.mintDeep)
        .padding(.top, 2)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 22)
  }

  private var filteredContacts: [ContactPerson] {
    guard !query.isEmpty, !query.hasPrefix("@") else { return contacts }
    return contacts.filter {
      $0.name.localizedCaseInsensitiveContains(query)
        || ($0.phone?.contains(query.filter(\.isNumber)) ?? false)
    }
  }

  private func loadContacts() async {
    defer { loading = false }
    let status = ContactService.shared.authorizationStatus
    if status == .denied || status == .restricted {
      contactsBlocked = true
      return
    }
    do {
      contacts = try await ContactService.shared.contacts()
    } catch {
      // Access was refused or is otherwise unavailable — fall back to the @handle path, no scary alert.
      contactsBlocked = true
    }
  }

  private func choose(_ contact: ContactPerson) async {
    guard let phone = contact.phone else { return }
    busyId = contact.id
    defer { busyId = nil }

    do {
      let resolution = try await PrismAPI.shared.resolve(phone: phone)
      if resolution.found {
        if let candidate = IdentityTrustStore.shared.reviewCandidate(for: contact, newResolution: resolution, action: mode.isPaying ? .send : .request) {
          dismiss()
          model.presentIdentityChange = candidate
          return
        }

        IdentityTrustStore.shared.remember(contact: contact, resolution: resolution)
        dismiss()
        deliver(contact: contact, resolution: resolution)
      } else if case .circlePay = mode {
        // A Circle cannot send before signup: the ClaimVault funds exclusively through an ERC-3009
        // signature, which a Safe has no key to produce. Audited and recorded as DEFERRED in
        // docs/CIRCLE_PAYMENTS.md §7 — so this is a clear refusal, not a silent omission.
        throw PickerError.circleCannotSendBeforeSignup
      } else if mode == .send {
        dismiss()
        model.presentUnregistered = contact
      } else {
        throw PickerError.recipientNotOnPrism
      }
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func resolveHandle(_ handle: String) async {
    busyId = "handle"
    defer { busyId = nil }

    do {
      let resolution = try await PrismAPI.shared.resolve(handle: handle)
      guard resolution.found else { throw PickerError.handleNotFound }
      let name = handle.replacingOccurrences(of: "@", with: "")
      let contact = ContactPerson(
        id: "handle:\(name)",
        name: "@\(name)",
        phone: nil,
        initials: String(name.prefix(2)).uppercased(),
        handle: "@\(name)",
        prismState: .onPrism(resolution)
      )
      if let candidate = IdentityTrustStore.shared.reviewCandidate(for: contact, newResolution: resolution, action: mode.isPaying ? .send : .request) {
        dismiss()
        model.presentIdentityChange = candidate
        return
      }
      IdentityTrustStore.shared.remember(contact: contact, resolution: resolution)
      dismiss()
      deliver(contact: contact, resolution: resolution)
    } catch {
      self.error = error.localizedDescription
    }
  }

  /// One place that decides where a resolved recipient goes, so the three modes cannot drift apart.
  private func deliver(contact: ContactPerson, resolution: ResolutionResponse) {
    switch mode {
    case .send:
      model.presentSend = SendTarget(contact: contact, resolution: resolution)
    case .request:
      model.presentRequest = SendTarget(contact: contact, resolution: resolution)
    case .circlePay(let circleId, let circleName):
      model.presentCirclePay = CirclePayTarget(
        circleId: circleId, circleName: circleName, contact: contact, resolution: resolution)
    }
  }

  private func masked(_ phone: String?) -> String {
    guard let phone else { return "" }
    let digits = phone.filter(\.isNumber)
    guard digits.count > 6 else { return phone }
    return "+\(digits.prefix(6)) ••• ••\(digits.suffix(2))"
  }
}

enum PickerError: LocalizedError {
  case recipientNotOnPrism, handleNotFound, circleCannotSendBeforeSignup
  var errorDescription: String? {
    switch self {
    case .recipientNotOnPrism:
      "This person is not on Prism yet. Payment requests can only be sent to an active Prism account."
    case .handleNotFound: "That Prism handle could not be found."
    case .circleCannotSendBeforeSignup:
      "This person hasn't joined Prism yet. A Circle can only pay an active Prism account. You can still send to them from your own balance."
    }
  }
}

final class IdentityTrustStore: @unchecked Sendable {
  static let shared = IdentityTrustStore()
  private let key = "trusted.recipient.identities"
  private init() {}

  /// The continuity state for paying this contact, computed by the shared `PrismContinuity` classifier
  /// against the last trusted binding (persisted, so it survives relaunch).
  func state(for contact: ContactPerson, newResolution: ResolutionResponse) -> PrismContinuityState {
    let known = records()[contact.id].map {
      KnownRecipientBinding(prismId: $0.prismId, account: $0.accountAddress, aliasVersion: $0.aliasVersion)
    }
    return PrismContinuity.classify(known: known, resolution: newResolution)
  }

  /// A review message when the payment must NOT silently proceed — the contact now resolves to a
  /// different PrismIdentity (discontinuity), or the resolver can't confirm it's the same account
  /// (ambiguous). A same-identity alias change or an authenticated account rotation is silent (continuity).
  func warning(for contact: ContactPerson, newResolution: ResolutionResponse) -> String? {
    switch state(for: contact, newResolution: newResolution) {
    case .identityDiscontinuity, .resolverUnavailableOrAmbiguous:
      return "\(contact.name)’s payment identity changed since your last trusted payment. Prism will not silently send to the new account. Review the identity before paying again."
    case .firstContact, .continuityMatch, .staleResolution:
      return nil
    }
  }

  /// What the payer last trusted for this contact, if anything. Read-only; the review surface uses it
  /// to show human-readable "previously trusted" context without re-deriving it.
  func trusted(contactId: String) -> ContactTrustRecord? { records()[contactId] }

  /// A review candidate when the payment/request must STOP for identity review, or `nil` when it may
  /// proceed (first contact, continuity match, or a same-identity route change). Centralized so every
  /// entry point (People, picker, send, request) makes the identical decision.
  func reviewCandidate(for contact: ContactPerson, newResolution: ResolutionResponse, action: IdentityChangeAction) -> IdentityChangeCandidate? {
    let s = state(for: contact, newResolution: newResolution)
    switch s {
    case .identityDiscontinuity, .resolverUnavailableOrAmbiguous:
      return IdentityChangeCandidate(contact: contact, resolution: newResolution, action: action, state: s, previous: trusted(contactId: contact.id))
    case .firstContact, .continuityMatch, .staleResolution:
      return nil
    }
  }

  func remember(contact: ContactPerson, resolution: ResolutionResponse) {
    guard let a = resolution.attestation else { return }
    var all = records()
    let existing = all[contact.id]
    all[contact.id] = ContactTrustRecord(
      localContactId: contact.id, prismId: a.prismIdentity, accountAddress: a.recipientAccount,
      aliasVersion: a.aliasVersion, establishedAt: existing?.establishedAt ?? Date())
    if let data = try? JSONEncoder().encode(all) { UserDefaults.standard.set(data, forKey: key) }
    // Record a transparent continuity event when a KNOWN contact's route advances but stays the same
    // PrismIdentity (a legitimate alias/account rotation). This is NOT a warning — it is the audit trail
    // for "the route changed and PRISM followed it because the person is the same."
    if let existing, existing.prismId.lowercased() == a.prismIdentity.lowercased(),
       existing.aliasVersion != a.aliasVersion || existing.accountAddress.lowercased() != a.recipientAccount.lowercased() {
      logContinuityEvent(ContinuityEvent(
        contactId: contact.id, contactName: contact.name, prismId: a.prismIdentity,
        fromAliasVersion: existing.aliasVersion, toAliasVersion: a.aliasVersion, at: Date()))
    }
  }

  /// Transparent continuity log — legitimate route changes for the same PrismIdentity. Local only.
  func continuityEvents() -> [ContinuityEvent] {
    guard let data = UserDefaults.standard.data(forKey: eventsKey),
      let value = try? JSONDecoder().decode([ContinuityEvent].self, from: data) else { return [] }
    return value
  }
  private func logContinuityEvent(_ event: ContinuityEvent) {
    var all = continuityEvents()
    all.append(event)
    if all.count > 50 { all.removeFirst(all.count - 50) } // keep the log bounded
    if let data = try? JSONEncoder().encode(all) { UserDefaults.standard.set(data, forKey: eventsKey) }
  }
  private let eventsKey = "continuity.events"

  func reset(contactId: String) {
    var all = records()
    all.removeValue(forKey: contactId)
    if let data = try? JSONEncoder().encode(all) { UserDefaults.standard.set(data, forKey: key) }
  }

  private func records() -> [String: ContactTrustRecord] {
    guard let data = UserDefaults.standard.data(forKey: key),
      let value = try? JSONDecoder().decode([String: ContactTrustRecord].self, from: data)
    else { return [:] }
    return value
  }
}
