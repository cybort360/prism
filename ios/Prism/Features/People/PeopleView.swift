import SwiftUI

struct PeopleView: View {
  enum Segment: String, CaseIterable {
    case contacts = "Contacts"
    case prism = "Prism"
  }
  @EnvironmentObject private var model: AppModel
  @State private var segment: Segment = .contacts
  @State private var contacts: [ContactPerson] = []
  @State private var query = ""
  @State private var resolving: String?
  @State private var error: String?

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Text("People").font(PrismTheme.display(36))
        Spacer()
        Button {
          query = "@"
          segment = .prism
        } label: {
          Image(systemName: "magnifyingglass").frame(width: 42, height: 42).background(
            PrismTheme.surface
          ).clipShape(Circle())
        }.buttonStyle(.plainHit)
      }.padding(.horizontal, 22).padding(.top, 12)
      HStack(spacing: 10) {
        Image(systemName: "magnifyingglass").foregroundStyle(PrismTheme.muted)
        TextField("Search contacts or @handle", text: $query).textInputAutocapitalization(.never)
          .autocorrectionDisabled()
      }.padding(.horizontal, 14).frame(height: 48).background(PrismTheme.surface).clipShape(
        RoundedRectangle(cornerRadius: 15)
      ).overlay(RoundedRectangle(cornerRadius: 15).stroke(PrismTheme.line, lineWidth: 0.7)).padding(
        .horizontal, 22
      ).padding(.top, 18)
      Picker("People", selection: $segment) {
        ForEach(Segment.allCases, id: \.self) { Text($0.rawValue).tag($0) }
      }.pickerStyle(.segmented).padding(.horizontal, 22).padding(.top, 10)
      if let error { ErrorBanner(message: error).padding(.horizontal, 22).padding(.top, 10) }
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          if segment == .prism { handleLookup } else { contactRows }
        }.padding(.horizontal, 22).padding(.top, 16).padding(.bottom, 30)
      }
    }.task { await load() }.prismScreen()
  }

  @ViewBuilder private var contactRows: some View {
    if filtered.isEmpty {
      EmptyStateView(
        icon: "person.2", title: "No contacts",
        bodyText: "Allow Contacts access or search an exact @Prism handle.")
    } else {
      ForEach(filtered) { p in
        Button {
          Task { await choose(p) }
        } label: {
          HStack(spacing: 13) {
            PrismAvatar(initials: p.initials, size: 44)
            VStack(alignment: .leading, spacing: 3) {
              Text(p.name).font(PrismTheme.body(15, weight: .semibold)).foregroundStyle(
                PrismTheme.ink)
              Text(masked(p.phone)).font(PrismTheme.body(12)).foregroundStyle(PrismTheme.muted)
            }
            Spacer()
            if resolving == p.id {
              ProgressView().controlSize(.small)
            } else if trusted(p) {
              PrismStatusPill(text: "Known", tone: .positive)
            } else {
              Text("Tap to check").font(PrismTheme.body(10)).foregroundStyle(PrismTheme.faint)
            }
          }.padding(.vertical, 12)
        }.buttonStyle(.plainHit)
        Divider().overlay(PrismTheme.line)
      }
    }
  }

  @ViewBuilder private var handleLookup: some View {
    let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.hasPrefix("@") && value.count > 1 {
      Button {
        Task { await resolveHandle(value) }
      } label: {
        HStack(spacing: 13) {
          PrismAvatar(initials: "@", size: 44)
          VStack(alignment: .leading, spacing: 3) {
            Text(value.lowercased()).font(PrismTheme.body(15, weight: .semibold)).foregroundStyle(
              PrismTheme.ink)
            Text("Exact Prism handle lookup").font(PrismTheme.body(12)).foregroundStyle(
              PrismTheme.muted)
          }
          Spacer()
          if resolving == "handle" {
            ProgressView()
          } else {
            Image(systemName: "arrow.right").foregroundStyle(PrismTheme.muted)
          }
        }.padding(.vertical, 14)
      }.buttonStyle(.plainHit)
    } else {
      EmptyStateView(
        icon: "at", title: "Search a Prism handle",
        bodyText: "Handles are exact-match payment identifiers, not a social directory.")
    }
  }

  private var filtered: [ContactPerson] {
    guard !query.isEmpty else { return contacts }
    return contacts.filter {
      $0.name.localizedCaseInsensitiveContains(query)
        || ($0.phone?.contains(query.filter(\.isNumber)) ?? false)
    }
  }
  private func load() async {
    do { contacts = try await ContactService.shared.contacts() } catch {
      self.error = "Contacts are unavailable. You can still use @Prism handles."
    }
  }
  private func choose(_ p: ContactPerson) async {
    guard let phone = p.phone else { return }
    resolving = p.id
    defer { resolving = nil }
    do {
      let r = try await PrismAPI.shared.resolve(phone: phone)
      if r.found {
        if let candidate = IdentityTrustStore.shared.reviewCandidate(for: p, newResolution: r, action: .send) {
          model.presentIdentityChange = candidate
        } else {
          IdentityTrustStore.shared.remember(contact: p, resolution: r)
          model.presentSend = SendTarget(contact: p, resolution: r)
        }
      } else {
        model.presentUnregistered = p
      }
    } catch { self.error = error.localizedDescription }
  }
  private func resolveHandle(_ h: String) async {
    resolving = "handle"
    defer { resolving = nil }
    do {
      let r = try await PrismAPI.shared.resolve(handle: h)
      guard r.found else { throw PickerError.handleNotFound }
      let n = h.replacingOccurrences(of: "@", with: "")
      let p = ContactPerson(
        id: "handle:\(n)", name: "@\(n)", phone: nil, initials: String(n.prefix(2)).uppercased(),
        handle: "@\(n)", prismState: .onPrism(r))
      if let candidate = IdentityTrustStore.shared.reviewCandidate(for: p, newResolution: r, action: .send) {
        model.presentIdentityChange = candidate
      } else {
        IdentityTrustStore.shared.remember(contact: p, resolution: r)
        model.presentSend = SendTarget(contact: p, resolution: r)
      }
    } catch { self.error = error.localizedDescription }
  }
  private func masked(_ phone: String?) -> String {
    guard let phone else { return "" }
    let d = phone.filter(\.isNumber)
    guard d.count > 6 else { return phone }
    return "+\(d.prefix(6)) ••• ••\(d.suffix(2))"
  }
  private func trusted(_ p: ContactPerson) -> Bool {
    IdentityTrustStore.shared.hasRecord(contactId: p.id)
  }
}

extension IdentityTrustStore {
  func hasRecord(contactId: String) -> Bool { storedRecord(contactId: contactId) != nil }
  fileprivate func storedRecord(contactId: String) -> ContactTrustRecord? {
    let key = "trusted.recipient.identities"
    guard let data = UserDefaults.standard.data(forKey: key),
      let all = try? JSONDecoder().decode([String: ContactTrustRecord].self, from: data)
    else { return nil }
    return all[contactId]
  }
}
