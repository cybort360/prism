import SwiftUI

/// Inviting someone into a Circle.
///
/// An invitation is where financial authority starts, so the role is chosen *before* the person is
/// picked and its consequence is on screen the whole time. That ordering is deliberate: choosing a
/// person first makes the role feel like a detail to tidy up afterwards, when it is the only part
/// of this screen that decides what they can do with the money.
///
/// The one thing this screen will not do is imply that inviting someone grants them anything.
/// Accepting makes them a member; admin authority still waits on the Circle approving them on
/// Monad, and the confirmation says so in those words.
struct CircleInviteView: View {
  let circleId: String
  let circleName: String
  let limitsEnabled: Bool
  let reload: () async -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var role: CircleVocabulary.Role = .contributor
  @State private var query = ""
  @State private var contacts: [ContactPerson] = []
  @State private var contactsBlocked = false
  @State private var busyId: String?
  @State private var error: String?
  @State private var sent: String?

  private var roles: [CircleVocabulary.Role] {
    CircleVocabulary.Role.invitableRoles(limitsEnabled: limitsEnabled)
  }

  private var matches: [ContactPerson] {
    guard !query.isEmpty, !query.hasPrefix("@") else { return Array(contacts.prefix(8)) }
    return contacts.filter {
      $0.name.localizedCaseInsensitiveContains(query)
        || ($0.phone?.contains(query.filter(\.isNumber)) ?? false)
    }
    .prefix(8).map { $0 }
  }

  var body: some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 0) {
        Text("What can they do?")
          .font(PrismTheme.display(25))
          .tracking(-0.4)
          .padding(.top, 8)

        rolePicker.padding(.top, 16)
        consequence.padding(.top, 14)

        if let sent { SuccessBanner(message: sent).padding(.top, 18) }
        if let error { ErrorBanner(message: error).padding(.top, 18) }

        PrismSectionLabel(text: "Who").padding(.top, 30).padding(.bottom, 12)
        search
        people.padding(.top, 6)
      }
      .padding(.horizontal, 22)
      .padding(.bottom, 36)
    }
    .prismScreen()
    .navigationTitle("Invite to \(circleName)")
    .navigationBarTitleDisplayMode(.inline)
    .task {
      let status = ContactService.shared.authorizationStatus
      if status == .denied || status == .restricted { contactsBlocked = true; return }
      do { contacts = try await ContactService.shared.contacts() } catch { contactsBlocked = true }
    }
  }

  private var rolePicker: some View {
    VStack(spacing: 9) {
      ForEach(roles) { option in
        Button {
          role = option
        } label: {
          HStack(spacing: 11) {
            Image(systemName: role == option ? "largecircle.fill.circle" : "circle")
              .font(.system(size: 18))
              .foregroundStyle(role == option ? PrismTheme.mintDeep : PrismTheme.faint)
            VStack(alignment: .leading, spacing: 2) {
              Text(option.title)
                .font(PrismTheme.body(14.5, weight: .semibold))
                .foregroundStyle(PrismTheme.ink)
              Text(option.summary)
                .font(PrismTheme.body(11.5))
                .foregroundStyle(PrismTheme.muted)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
          }
          .padding(14)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(PrismTheme.paper)
          .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 17, style: .continuous)
              .stroke(role == option ? PrismTheme.mintDeep : PrismTheme.line, lineWidth: role == option ? 1.4 : 0.7))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(option.title). \(option.summary)")
        .accessibilityValue(role == option ? "Selected" : "Not selected")
        .accessibilityAddTraits(.isButton)
      }
    }
  }

  /// What this role actually hands over, stated before anyone is picked.
  private var consequence: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: role.needsCircleApproval ? "exclamationmark.shield.fill" : "info.circle.fill")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(role.needsCircleApproval ? PrismTheme.amber : PrismTheme.pending)
        .accessibilityHidden(true)
      Text(role.consequence)
        .font(PrismTheme.body(12.5))
        .foregroundStyle(PrismTheme.ink)
        .lineSpacing(2)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(role.needsCircleApproval ? PrismTheme.amber.opacity(0.075) : PrismTheme.canvas)
    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    .accessibilityElement(children: .combine)
  }

  private var search: some View {
    HStack(spacing: 11) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(PrismTheme.muted)
      TextField("Search contacts or @handle", text: $query)
        .font(PrismTheme.body(14))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
    }
    .padding(.horizontal, 15)
    .frame(height: 50)
    .background(PrismTheme.paper)
    .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))
  }

  @ViewBuilder private var people: some View {
    if query.hasPrefix("@") && query.count > 1 {
      inviteRow(
        initials: "@", name: query.lowercased(), detail: "Exact Prism handle",
        busy: busyId == "handle"
      ) {
        await send(prismId: nil, handle: query.lowercased(), name: query.lowercased())
      }
    }

    ForEach(matches) { contact in
      inviteRow(
        initials: contact.initials, name: contact.name,
        detail: contact.handle ?? "In your contacts",
        busy: busyId == contact.id
      ) {
        await inviteContact(contact)
      }
    }

    if contactsBlocked && !query.hasPrefix("@") {
      Text("Contacts access is off. Type someone's @handle above to invite them — you don't need your contacts.")
        .font(PrismTheme.body(12))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(2)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 12)
    } else if matches.isEmpty && !query.hasPrefix("@") {
      Text(query.isEmpty
        ? "No contacts with a phone number yet. You can also invite anyone by their @handle."
        : "No matches. Try their @handle instead.")
        .font(PrismTheme.body(12))
        .foregroundStyle(PrismTheme.muted)
        .padding(.top, 12)
    }
  }

  private func inviteRow(initials: String, name: String, detail: String, busy: Bool, send: @escaping () async -> Void) -> some View {
    Button {
      Task { await send() }
    } label: {
      HStack(spacing: 12) {
        PrismAvatar(initials: initials, size: 44)
        VStack(alignment: .leading, spacing: 2) {
          Text(name).font(PrismTheme.body(14.5, weight: .semibold)).foregroundStyle(PrismTheme.ink).lineLimit(1)
          Text(detail).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted).lineLimit(1)
        }
        Spacer()
        if busy {
          ProgressView().controlSize(.small).tint(PrismTheme.mintDeep)
        } else {
          Text("Invite")
            .font(PrismTheme.body(13, weight: .semibold))
            .foregroundStyle(PrismTheme.mintDeep)
        }
      }
      .padding(.vertical, 11)
    }
    .buttonStyle(.plain)
    .disabled(busyId != nil)
    .accessibilityLabel("Invite \(name) as \(role.title)")
  }

  private func inviteContact(_ contact: ContactPerson) async {
    guard let phone = contact.phone else { return }
    busyId = contact.id
    defer { busyId = nil }
    do {
      // Resolved through the same Protected Alias Resolver a payment uses, so an invitation lands on
      // the same identity a payment to them would.
      let resolution = try await PrismAPI.shared.resolve(phone: phone)
      guard resolution.found, let attestation = resolution.attestation else {
        throw CircleDraftError.notOnPrism(contact.name)
      }
      await send(prismId: attestation.prismIdentity, handle: nil, name: contact.name)
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func send(prismId: String?, handle: String?, name: String) async {
    busyId = prismId ?? "handle"
    defer { busyId = nil }
    error = nil
    do {
      _ = try await PrismAPI.shared.inviteToCircle(
        circleId: circleId, prismId: prismId, handle: handle, role: role.rawValue)
      sent = role.needsCircleApproval
        ? "\(name) was invited. They'll be a member as soon as they accept — becoming an admin also needs the Circle to approve it on Monad."
        : "\(name) was invited to \(circleName)."
      query = ""
      PrismHaptics.success()
      await reload()
    } catch {
      self.error = error.localizedDescription
      PrismHaptics.error()
    }
  }
}
