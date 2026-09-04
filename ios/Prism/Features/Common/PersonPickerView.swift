import SwiftUI

enum PersonPickerMode { case send, request }

struct PersonPickerView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  let mode: PersonPickerMode
  @State private var contacts: [ContactPerson] = []
  @State private var query = ""
  @State private var busyId: String?
  @State private var error: String?

  var body: some View {
    VStack(spacing: 0) {
      PrismSheetHeader(
        title: mode == .send ? "Send money" : "Request money",
        subtitle: mode == .send ? "Choose who you want to pay" : "Choose who to request from",
        close: { dismiss() }
      )

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

  private var filteredContacts: [ContactPerson] {
    guard !query.isEmpty, !query.hasPrefix("@") else { return contacts }
    return contacts.filter {
      $0.name.localizedCaseInsensitiveContains(query)
        || ($0.phone?.contains(query.filter(\.isNumber)) ?? false)
    }
  }

  private func loadContacts() async {
    do {
      contacts = try await ContactService.shared.contacts()
    } catch {
      self.error = "Contacts are unavailable. You can still search an @Prism handle."
    }
  }

  private func choose(_ contact: ContactPerson) async {
    guard let phone = contact.phone else { return }
    busyId = contact.id
    defer { busyId = nil }

    do {
      let resolution = try await PrismAPI.shared.resolve(phone: phone)
      if resolution.found {
        if IdentityTrustStore.shared.warning(for: contact, newResolution: resolution) != nil {
          dismiss()
          model.presentIdentityChange = IdentityChangeCandidate(
            contact: contact, resolution: resolution, action: mode == .send ? .send : .request)
          return
        }

        IdentityTrustStore.shared.remember(contact: contact, resolution: resolution)
        dismiss()
        if mode == .send {
          model.presentSend = SendTarget(contact: contact, resolution: resolution)
        } else {
          model.presentRequest = SendTarget(contact: contact, resolution: resolution)
        }
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
      if IdentityTrustStore.shared.warning(for: contact, newResolution: resolution) != nil {
        dismiss()
        model.presentIdentityChange = IdentityChangeCandidate(
          contact: contact, resolution: resolution, action: mode == .send ? .send : .request)
        return
      }
      IdentityTrustStore.shared.remember(contact: contact, resolution: resolution)
      dismiss()
      if mode == .send {
        model.presentSend = SendTarget(contact: contact, resolution: resolution)
      } else {
        model.presentRequest = SendTarget(contact: contact, resolution: resolution)
      }
    } catch {
      self.error = error.localizedDescription
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
  case recipientNotOnPrism, handleNotFound
  var errorDescription: String? {
    switch self {
    case .recipientNotOnPrism:
      "This person is not on Prism yet. Payment requests can only be sent to an active Prism account."
    case .handleNotFound: "That Prism handle could not be found."
    }
  }
}

final class IdentityTrustStore: @unchecked Sendable {
  static let shared = IdentityTrustStore()
  private let key = "trusted.recipient.identities"
  private init() {}

  func warning(for contact: ContactPerson, newResolution: ResolutionResponse) -> String? {
    guard let att = newResolution.attestation, let old = records()[contact.id] else { return nil }
    guard
      old.prismId != att.prismIdentity
        || old.accountAddress.lowercased() != att.recipientAccount.lowercased()
    else { return nil }
    return
      "\(contact.name)’s payment identity changed since your last trusted payment. Prism will not silently send to the new account. Review the identity before paying again."
  }

  func remember(contact: ContactPerson, resolution: ResolutionResponse) {
    guard let a = resolution.attestation else { return }
    var all = records()
    all[contact.id] = ContactTrustRecord(
      localContactId: contact.id, prismId: a.prismIdentity, accountAddress: a.recipientAccount,
      aliasVersion: a.aliasVersion, establishedAt: Date())
    if let data = try? JSONEncoder().encode(all) { UserDefaults.standard.set(data, forKey: key) }
  }

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
