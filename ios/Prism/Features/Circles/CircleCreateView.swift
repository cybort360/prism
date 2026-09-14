import SwiftUI

/// Creating a Circle, in six steps.
///
/// The shape of this flow is an argument about consent. Choosing a name and choosing who can move
/// the money are not the same kind of decision, so they are not the same screen; and the last thing
/// a person sees before authorizing is not a summary of what they typed but a plain statement of
/// **who can move this money** — the only fact that will matter later.
///
/// Two things are deliberately not hidden. The approval rule is presented with the consequence of
/// each option rather than a single recommended number, because a 2-of-2 Circle that loses a phone
/// is frozen forever and no one should meet that fact afterwards. And a spending limit is never
/// promised here: limits are changes the Circle has to approve on Monad, so this flow can record the
/// intent and say so, and nothing more.
struct CircleCreateView: View {
  @EnvironmentObject private var model: AppModel
  @Environment(\.dismiss) private var dismiss
  @StateObject private var draft = CircleDraft()

  var body: some View {
    ZStack {
      VStack(spacing: 0) {
        header
        progress.padding(.horizontal, 24).padding(.top, 4).padding(.bottom, 6)

        ScrollView(showsIndicators: false) {
          VStack(alignment: .leading, spacing: 0) {
            switch draft.step {
            case .name: CircleCreateNameStep(draft: draft)
            case .people: CircleCreatePeopleStep(draft: draft)
            case .admins: CircleCreateAdminsStep(draft: draft)
            case .approvalRule: CircleCreateApprovalStep(draft: draft)
            case .spending: CircleCreateSpendingStep(draft: draft)
            case .review: CircleCreateReviewStep(draft: draft)
            }
          }
          .padding(.horizontal, 24)
          .padding(.top, 18)
          .padding(.bottom, 24)
        }

        if let error = draft.error {
          ErrorBanner(message: error).padding(.horizontal, 24).padding(.bottom, 10)
        }

        footer
      }
      .prismScreen()

      if draft.creation != .idle {
        CircleCreationOverlay(state: draft.creation) {
          draft.creation = .idle
        } finish: {
          let created = draft.created
          dismiss()
          if let created { model.presentCircleDetail = created }
        }
      }
    }
    .sheet(isPresented: $draft.showAuthorization) {
      CircleAuthorizationSheet(
        title: "Create Circle",
        subtitle: draft.name,
        detail: draft.authorizationDetail
      ) { pin, face in
        Task { await draft.create(pin: pin, useFaceID: face) }
      }
    }
    .task { await draft.load(me: model.identity) }
    .onChange(of: draft.adminIds) { _, _ in Task { await draft.refreshGuidance() } }
  }

  private var header: some View {
    HStack(alignment: .top, spacing: 16) {
      VStack(alignment: .leading, spacing: 5) {
        PrismSectionLabel(text: "New Circle")
        Text(draft.step.question)
          .font(PrismTheme.display(28))
          .tracking(-0.5)
          .lineLimit(3)
          .minimumScaleFactor(0.75)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      PrismHeaderIconButton(icon: "xmark") { dismiss() }
        .accessibilityLabel("Close")
    }
    .padding(.horizontal, 24)
    .padding(.top, 20)
    .padding(.bottom, 16)
  }

  private var progress: some View {
    HStack(spacing: 5) {
      ForEach(CircleDraft.Step.allCases) { step in
        Capsule()
          .fill(step.rawValue <= draft.step.rawValue ? PrismTheme.mintDeep : PrismTheme.line)
          .frame(height: 3)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Step \(draft.step.rawValue + 1) of \(CircleDraft.Step.allCases.count)")
  }

  private var footer: some View {
    HStack(spacing: 10) {
      if draft.step != .name {
        Button {
          draft.back()
        } label: {
          Image(systemName: "chevron.left")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(PrismTheme.ink)
            .frame(width: 56, height: 56)
            .background(PrismTheme.paper)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back")
      }

      PrismPrimaryButton(
        title: draft.step == .review ? "Create Circle" : "Continue",
        enabled: draft.canAdvance,
        icon: draft.step == .review ? "checkmark.shield.fill" : nil
      ) {
        if draft.step == .review { draft.showAuthorization = true } else { draft.advance() }
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 20)
    .padding(.top, 4)
  }
}

// MARK: - step 1: name

private struct CircleCreateNameStep: View {
  @ObservedObject var draft: CircleDraft
  @FocusState private var focused: Bool

  /// A small, fixed set of SF Symbols rather than emoji: they match the rest of the app's iconography,
  /// tint to the brand, and read cleanly at any size. The stored icon is the symbol name.
  private let icons: [(name: String, label: String)] = [
    ("airplane", "Trip"), ("house.fill", "Home"), ("gift.fill", "Gift"), ("fork.knife", "Dining"),
    ("car.fill", "Car"), ("graduationcap.fill", "School"), ("soccerball", "Sports"), ("party.popper.fill", "Celebration")
  ]

  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      VStack(alignment: .leading, spacing: 8) {
        PrismSectionLabel(text: "Circle name")
        TextField("Lagos Trip", text: $draft.name)
          .font(PrismTheme.body(17, weight: .semibold))
          .focused($focused)
          .submitLabel(.done)
          .padding(.horizontal, 16)
          .frame(height: 56)
          .background(PrismTheme.paper)
          .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
          .accessibilityLabel("Circle name")
      }

      VStack(alignment: .leading, spacing: 10) {
        PrismSectionLabel(text: "Icon (optional)")
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 9), count: 4), spacing: 9) {
          ForEach(icons, id: \.name) { icon in
            let selected = draft.icon == icon.name
            Button {
              draft.icon = selected ? nil : icon.name
            } label: {
              Image(systemName: icon.name)
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(selected ? PrismTheme.mintDeep : PrismTheme.ink)
                .frame(maxWidth: .infinity)
                .frame(height: 54)
                .background(selected ? PrismTheme.mintSoft : PrismTheme.paper)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(
                  RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(selected ? PrismTheme.mintDeep : PrismTheme.line, lineWidth: selected ? 1.4 : 0.7))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(icon.label)
            .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
          }
        }
      }

      // The kind of Circle is what makes a *recommendation* possible later: a household and a
      // one-off group fund do not want the same approval rule, and guessing silently would be worse
      // than asking once.
      VStack(alignment: .leading, spacing: 10) {
        PrismSectionLabel(text: "What kind of Circle is this?")
        HStack(spacing: 8) {
          ForEach(CircleDraft.Kind.allCases) { kind in
            Button {
              draft.kind = kind
              Task { await draft.refreshGuidance() }
            } label: {
              Text(kind.label)
                .font(PrismTheme.body(13.5, weight: .semibold))
                .foregroundStyle(draft.kind == kind ? .white : PrismTheme.ink)
                .frame(maxWidth: .infinity)
                .frame(height: 46)
                .background(draft.kind == kind ? PrismTheme.mintDeep : PrismTheme.paper)
                .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
                .overlay(
                  RoundedRectangle(cornerRadius: 15, style: .continuous)
                    .stroke(draft.kind == kind ? Color.clear : PrismTheme.line, lineWidth: 0.7))
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(draft.kind == kind ? [.isButton, .isSelected] : .isButton)
          }
        }
        Text(draft.kind.blurb)
          .font(PrismTheme.body(12))
          .foregroundStyle(PrismTheme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .onAppear { focused = draft.name.isEmpty }
  }
}

// MARK: - step 2: people

private struct CircleCreatePeopleStep: View {
  @ObservedObject var draft: CircleDraft

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("Everyone here will see the balance and everything that moves. You'll choose who can approve payments next.")
        .font(PrismTheme.body(13.5))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(2)
        .fixedSize(horizontal: false, vertical: true)

      CirclePersonSearchField(draft: draft)

      if !draft.people.isEmpty {
        VStack(alignment: .leading, spacing: 10) {
          PrismSectionLabel(text: "\(draft.people.count + 1) in this Circle")
          CircleAvatarStrip(people: [draft.me].compactMap { $0 } + draft.people)
          VStack(spacing: 0) {
            ForEach(draft.people) { person in
              HStack(spacing: 12) {
                PrismAvatar(initials: person.initials, size: 42)
                VStack(alignment: .leading, spacing: 2) {
                  Text(person.name).font(PrismTheme.body(14.5, weight: .semibold))
                  if let handle = person.handle {
                    Text(handle).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
                  }
                }
                Spacer()
                Button {
                  draft.remove(person)
                } label: {
                  Image(systemName: "minus.circle.fill")
                    .font(.system(size: 19))
                    .foregroundStyle(PrismTheme.faint)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(person.name)")
              }
              .padding(.vertical, 11)
              Divider().overlay(PrismTheme.line)
            }
          }
        }
      } else {
        CircleStateView(state: .noMembers, compact: true)
      }
    }
  }
}

// MARK: - step 3: admins

private struct CircleCreateAdminsStep: View {
  @ObservedObject var draft: CircleDraft

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("Admins approve large payments and changes to how the Circle works, like adding someone or changing how many approvals a payment needs.")
        .font(PrismTheme.body(13.5))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(2)
        .fixedSize(horizontal: false, vertical: true)

      VStack(spacing: 0) {
        if let me = draft.me {
          // The creator is always an admin — a Circle with no admin could never be governed — so
          // this row is shown as a fact rather than offered as a choice.
          HStack(spacing: 12) {
            PrismAvatar(initials: me.initials, size: 44, highlighted: true)
            VStack(alignment: .leading, spacing: 2) {
              Text("\(me.name) (you)").font(PrismTheme.body(14.5, weight: .semibold))
              Text("Always an admin of a Circle you create")
                .font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
            }
            Spacer()
            Image(systemName: "checkmark.circle.fill")
              .font(.system(size: 20)).foregroundStyle(PrismTheme.mintDeep)
              .accessibilityHidden(true)
          }
          .padding(.vertical, 12)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("\(me.name), you, always an admin")
          Divider().overlay(PrismTheme.line)
        }

        ForEach(draft.people) { person in
          Button {
            draft.toggleAdmin(person)
          } label: {
            HStack(spacing: 12) {
              PrismAvatar(initials: person.initials, size: 44, highlighted: draft.adminIds.contains(person.id))
              VStack(alignment: .leading, spacing: 2) {
                Text(person.name).font(PrismTheme.body(14.5, weight: .semibold)).foregroundStyle(PrismTheme.ink)
                Text(draft.adminIds.contains(person.id) ? "Can approve payments" : "Can't approve payments")
                  .font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
              }
              Spacer()
              Image(systemName: draft.adminIds.contains(person.id) ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 20))
                .foregroundStyle(draft.adminIds.contains(person.id) ? PrismTheme.mintDeep : PrismTheme.faint)
            }
            .padding(.vertical, 12)
          }
          .buttonStyle(.plain)
          .accessibilityLabel(person.name)
          .accessibilityValue(draft.adminIds.contains(person.id) ? "Admin" : "Not an admin")
          .accessibilityAddTraits(.isButton)
          Divider().overlay(PrismTheme.line)
        }
      }

      if draft.people.isEmpty {
        Text("You're the only person in this Circle, so you're its only admin. You can add people and make them admins later.")
          .font(PrismTheme.body(12.5))
          .foregroundStyle(PrismTheme.muted)
          .lineSpacing(2)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

// MARK: - step 4: approval rule

private struct CircleCreateApprovalStep: View {
  @ObservedObject var draft: CircleDraft

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Every payment out of \(draft.name.isEmpty ? "this Circle" : draft.name) waits until this many admins have approved it.")
        .font(PrismTheme.body(13.5))
        .foregroundStyle(PrismTheme.muted)
        .lineSpacing(2)
        .fixedSize(horizontal: false, vertical: true)

      if draft.thresholdChoices.isEmpty {
        // No locally-invented options: a rule is only offered once its consequence is known.
        if draft.loadingGuidance {
          PrismLoadingRow()
        } else {
          CircleNotice(state: .networkUnavailable(
            detail: "Prism can't show what each approval rule would mean right now, and won't offer one without that. Nothing has been created."
          )) {
            Task { await draft.refreshGuidance() }
          }
        }
      }

      ForEach(draft.thresholdChoices, id: \.threshold) { choice in
        Button {
          draft.threshold = choice.threshold
        } label: {
          VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
              Image(systemName: draft.threshold == choice.threshold ? "largecircle.fill.circle" : "circle")
                .font(.system(size: 18))
                .foregroundStyle(draft.threshold == choice.threshold ? PrismTheme.mintDeep : PrismTheme.faint)
              Text(choice.label)
                .font(PrismTheme.body(15.5, weight: .semibold))
                .foregroundStyle(PrismTheme.ink)
              if choice.recommended {
                CircleStatusBadge(text: "Recommended", tone: .positive, symbol: "star.fill")
              }
              Spacer()
            }
            Text(CircleVocabulary.approvalRuleConsequence(threshold: choice.threshold, admins: draft.adminCount))
              .font(PrismTheme.body(12.5))
              .foregroundStyle(PrismTheme.muted)
              .lineSpacing(2)
              .multilineTextAlignment(.leading)
              .fixedSize(horizontal: false, vertical: true)
              .padding(.leading, 26)

            // The warnings the backend will require an acknowledgement for, shown here rather than
            // sprung at the end. Selecting this option is the acknowledgement.
            ForEach(choice.warnings) { warning in
              HStack(alignment: .top, spacing: 7) {
                Image(systemName: "exclamationmark.triangle.fill")
                  .font(.system(size: 10, weight: .bold))
                  .foregroundStyle(PrismTheme.amber)
                Text(warning.detail)
                  .font(PrismTheme.body(11.5, weight: .medium))
                  .foregroundStyle(PrismTheme.amber)
                  .multilineTextAlignment(.leading)
                  .fixedSize(horizontal: false, vertical: true)
              }
              .padding(.leading, 26)
            }
          }
          .padding(15)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(PrismTheme.paper)
          .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
              .stroke(draft.threshold == choice.threshold ? PrismTheme.mintDeep : PrismTheme.line,
                      lineWidth: draft.threshold == choice.threshold ? 1.4 : 0.7))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel(for: choice))
        .accessibilityValue(draft.threshold == choice.threshold ? "Selected" : "Not selected")
        .accessibilityAddTraits(.isButton)
      }
    }
  }

  private func accessibilityLabel(for choice: CircleThresholdChoice) -> String {
    var parts = [choice.label]
    if choice.recommended { parts.append("Recommended") }
    parts.append(CircleVocabulary.approvalRuleConsequence(threshold: choice.threshold, admins: draft.adminCount))
    parts.append(contentsOf: choice.warnings.map { "Warning. \($0.detail)" })
    return parts.joined(separator: ". ")
  }
}

// MARK: - step 5: spending access

private struct CircleCreateSpendingStep: View {
  @ObservedObject var draft: CircleDraft

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if draft.limitsEnabled {
        Text("Someone with a spending limit can pay out of the Circle on their own, up to their limit. Anything above it still needs the Circle's approval.")
          .font(PrismTheme.body(13.5))
          .foregroundStyle(PrismTheme.muted)
          .lineSpacing(2)
          .fixedSize(horizontal: false, vertical: true)

        ForEach(draft.allPeople) { person in
          CircleSpendingAccessRow(draft: draft, person: person)
        }

        Text("Spending limits are set on Monad, so each one has to be approved by the Circle's admins after it's created. Prism will ask for those approvals once the Circle is ready.")
          .font(PrismTheme.body(12))
          .foregroundStyle(PrismTheme.muted)
          .lineSpacing(2)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        // Not faked, and not hidden either: the honest answer is that every payment is approved by
        // the admins, which is a complete and safe way for a Circle to work.
        CircleStateView(state: .limitsUnavailable(reason: draft.limitsReason), compact: true)
        VStack(alignment: .leading, spacing: 10) {
          PrismSectionLabel(text: "So, in this Circle")
          ForEach(draft.allPeople) { person in
            HStack(spacing: 12) {
              PrismAvatar(initials: person.initials, size: 40)
              Text(person.id == draft.me?.id ? "\(person.name) (you)" : person.name)
                .font(PrismTheme.body(14, weight: .semibold))
              Spacer()
              CircleStatusBadge(text: "Approval required", tone: .neutral, symbol: "person.2.fill")
            }
            .padding(.vertical, 9)
          }
        }
      }
    }
  }
}

private struct CircleSpendingAccessRow: View {
  @ObservedObject var draft: CircleDraft
  let person: CircleCandidate

  private var access: CircleDraft.SpendingAccess {
    draft.spendingAccess[person.id] ?? .approvalRequired
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 11) {
      HStack(spacing: 12) {
        PrismAvatar(initials: person.initials, size: 42)
        VStack(alignment: .leading, spacing: 2) {
          Text(person.id == draft.me?.id ? "\(person.name) (you)" : person.name)
            .font(PrismTheme.body(14.5, weight: .semibold))
          Text(access.summary)
            .font(PrismTheme.body(11.5))
            .foregroundStyle(PrismTheme.muted)
        }
        Spacer()
      }

      Picker("Spending access for \(person.name)", selection: Binding(
        get: { access },
        set: { draft.spendingAccess[person.id] = $0 }
      )) {
        ForEach(CircleDraft.SpendingAccess.allCases) { option in
          Text(option.shortLabel).tag(option)
        }
      }
      .pickerStyle(.segmented)

      if access == .canSpend {
        HStack(spacing: 9) {
          TextField("100", text: Binding(
            get: { draft.spendingAmount[person.id] ?? "" },
            set: { draft.spendingAmount[person.id] = $0 }
          ))
          .keyboardType(.decimalPad)
          .font(PrismTheme.body(15, weight: .semibold))
          .padding(.horizontal, 14)
          .frame(height: 46)
          .background(PrismTheme.paper)
          .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
          .accessibilityLabel("Spending limit amount for \(person.name), in dollars")

          Picker("Limit period for \(person.name)", selection: Binding(
            get: { draft.spendingPeriod[person.id] ?? "DAILY" },
            set: { draft.spendingPeriod[person.id] = $0 }
          )) {
            Text("per day").tag("DAILY")
            Text("per week").tag("WEEKLY")
            Text("per month").tag("MONTHLY")
            Text("in total").tag("TOTAL")
          }
          .pickerStyle(.menu)
          .tint(PrismTheme.mintDeep)
        }
      }
    }
    .padding(.vertical, 10)
    .overlay(alignment: .bottom) { Divider().overlay(PrismTheme.line) }
  }
}

// MARK: - step 6: review

private struct CircleCreateReviewStep: View {
  @ObservedObject var draft: CircleDraft

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      HStack(spacing: 13) {
        ZStack {
          Circle().fill(PrismTheme.mintSoft).frame(width: 54, height: 54)
          CircleGlyph(icon: draft.icon, name: draft.name, size: 22)
        }
        .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 3) {
          Text(draft.name.uppercased())
            .font(PrismTheme.body(15, weight: .semibold))
            .tracking(0.8)
          Text("\(draft.allPeople.count) \(draft.allPeople.count == 1 ? "person" : "people")")
            .font(PrismTheme.body(12.5))
            .foregroundStyle(PrismTheme.muted)
        }
        Spacer()
      }

      summaryCard

      // The last thing before authorizing, and the only thing that will matter later.
      VStack(alignment: .leading, spacing: 10) {
        PrismSectionLabel(text: "Who can move this money")
        VStack(alignment: .leading, spacing: 9) {
          ForEach(draft.authorityStatements, id: \.self) { statement in
            HStack(alignment: .top, spacing: 9) {
              Image(systemName: "arrow.right")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(PrismTheme.mintDeep)
                .padding(.top, 4)
                .accessibilityHidden(true)
              Text(statement)
                .font(PrismTheme.body(13))
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
        .padding(15)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PrismTheme.mintSoft.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
      }
    }
  }

  private var summaryCard: some View {
    VStack(spacing: 0) {
      row("Admins", draft.adminNames.joined(separator: ", "))
      Divider().overlay(PrismTheme.line)
      row("Payments require", CircleVocabulary.approvalRule(threshold: draft.threshold, admins: draft.adminCount))
      if draft.limitsEnabled {
        ForEach(draft.spendingSummaryLines) { line in
          Divider().overlay(PrismTheme.line)
          row(line.who, line.what)
        }
      }
    }
    .padding(.horizontal, 15)
    .background(PrismTheme.paper)
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.7))
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(label)
        .font(PrismTheme.body(12.5))
        .foregroundStyle(PrismTheme.muted)
      Spacer(minLength: 8)
      Text(value)
        .font(PrismTheme.body(13.5, weight: .semibold))
        .multilineTextAlignment(.trailing)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, 13)
    .accessibilityElement(children: .combine)
  }
}

// MARK: - shared pieces

private struct CircleAvatarStrip: View {
  let people: [CircleCandidate]

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(people) { person in
          VStack(spacing: 6) {
            PrismAvatar(initials: person.initials, size: 46)
            Text(person.name.split(separator: " ").first.map(String.init) ?? person.name)
              .font(PrismTheme.body(10.5))
              .lineLimit(1)
              .frame(maxWidth: 56)
          }
        }
      }
      .padding(.vertical, 2)
    }
    .accessibilityHidden(true)
  }
}

/// Contacts and exact @handles, resolved through the same Protected Alias Resolver a payment uses.
///
/// A person cannot be added to a Circle from a name alone: being an admin means being an authority
/// on Monad, so every candidate is resolved to a real Prism identity here, and one that has not
/// finished setting up their account is refused with a reason rather than added and broken later.
private struct CirclePersonSearchField: View {
  @ObservedObject var draft: CircleDraft
  @State private var query = ""
  @State private var contacts: [ContactPerson] = []
  @State private var busyId: String?
  @State private var contactsBlocked = false

  private var matches: [ContactPerson] {
    guard !query.isEmpty, !query.hasPrefix("@") else { return [] }
    return contacts.filter {
      $0.name.localizedCaseInsensitiveContains(query)
        || ($0.phone?.contains(query.filter(\.isNumber)) ?? false)
    }
    .prefix(6).map { $0 }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 11) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(PrismTheme.muted)
        TextField("Search contacts or @handle", text: $query)
          .font(PrismTheme.body(14))
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
        if busyId != nil { ProgressView().controlSize(.small).tint(PrismTheme.mintDeep) }
      }
      .padding(.horizontal, 15)
      .frame(height: 50)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous).stroke(PrismTheme.line, lineWidth: 0.6))

      if query.hasPrefix("@") && query.count > 1 {
        Button { Task { await addHandle(query) } } label: {
          HStack(spacing: 12) {
            PrismAvatar(initials: "@", size: 42, tone: PrismTheme.mintSoft)
            VStack(alignment: .leading, spacing: 2) {
              Text(query.lowercased()).font(PrismTheme.body(14.5, weight: .semibold)).foregroundStyle(PrismTheme.ink)
              Text("Exact Prism handle").font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
            }
            Spacer()
            Image(systemName: "plus.circle.fill").font(.system(size: 19)).foregroundStyle(PrismTheme.mintDeep)
          }
          .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
      }

      ForEach(matches) { contact in
        Button { Task { await addContact(contact) } } label: {
          HStack(spacing: 12) {
            PrismAvatar(initials: contact.initials, size: 42)
            VStack(alignment: .leading, spacing: 2) {
              Text(contact.name).font(PrismTheme.body(14.5, weight: .semibold)).foregroundStyle(PrismTheme.ink)
              Text(contact.handle ?? "In your contacts").font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.muted)
            }
            Spacer()
            Image(systemName: "plus.circle.fill").font(.system(size: 19)).foregroundStyle(PrismTheme.mintDeep)
          }
          .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add \(contact.name) to this Circle")
      }

      if contactsBlocked && query.isEmpty {
        Text("Contacts access is off. Type someone's @handle above to add them. You don't need your contacts.")
          .font(PrismTheme.body(12))
          .foregroundStyle(PrismTheme.muted)
          .lineSpacing(2)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .task {
      let status = ContactService.shared.authorizationStatus
      if status == .denied || status == .restricted { contactsBlocked = true; return }
      do { contacts = try await ContactService.shared.contacts() } catch { contactsBlocked = true }
    }
  }

  private func addContact(_ contact: ContactPerson) async {
    guard let phone = contact.phone else { return }
    busyId = contact.id
    defer { busyId = nil; query = "" }
    do {
      let resolution = try await PrismAPI.shared.resolve(phone: phone)
      try draft.add(name: contact.name, handle: contact.handle, initials: contact.initials, resolution: resolution)
    } catch { draft.error = error.localizedDescription }
  }

  private func addHandle(_ handle: String) async {
    busyId = "handle"
    defer { busyId = nil; query = "" }
    let name = handle.replacingOccurrences(of: "@", with: "").lowercased()
    do {
      let resolution = try await PrismAPI.shared.resolve(handle: name)
      try draft.add(name: "@\(name)", handle: "@\(name)", initials: String(name.prefix(2)).uppercased(), resolution: resolution)
    } catch { draft.error = error.localizedDescription }
  }
}

/// Creating… → Confirming… → Circle ready.
///
/// The middle state is the honest one and it is not skippable: a Circle is not ready when a
/// transaction is broadcast, it is ready when Prism has read the deployed Circle back from Monad and
/// found it matches exactly what was authorized. Anything before that says Confirming.
private struct CircleCreationOverlay: View {
  let state: CircleDraft.Creation
  let dismiss: () -> Void
  let finish: () -> Void

  var body: some View {
    ZStack {
      Color.black.opacity(0.22).ignoresSafeArea()
      VStack(spacing: 16) {
        icon
        Text(label)
          .font(PrismTheme.display(isTerminal ? 23 : 26))
          .multilineTextAlignment(.center)
          .lineSpacing(2)
          .fixedSize(horizontal: false, vertical: true)
        if case .failed(let message) = state {
          Text(message)
            .font(PrismTheme.body(12.5))
            .foregroundStyle(PrismTheme.muted)
            .multilineTextAlignment(.center)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
        }
        actions
      }
      .padding(.horizontal, 26)
      .padding(.vertical, 28)
      .frame(maxWidth: 330)
      .background(PrismTheme.paper)
      .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
      .prismCardShadow()
    }
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(.isModal)
  }

  private var isTerminal: Bool {
    if case .failed = state { return true }
    if case .ready = state { return true }
    return false
  }

  @ViewBuilder private var icon: some View {
    switch state {
    case .ready:
      Circle().fill(PrismTheme.mintSoft).frame(width: 72, height: 72).overlay(
        Image(systemName: "checkmark").font(.system(size: 27, weight: .semibold)).foregroundStyle(PrismTheme.mintDeep))
    case .failed:
      Circle().fill(PrismTheme.danger.opacity(0.08)).frame(width: 72, height: 72).overlay(
        Image(systemName: "exclamationmark").font(.system(size: 27, weight: .semibold)).foregroundStyle(PrismTheme.danger))
    default:
      ProgressView().tint(PrismTheme.mintDeep).scaleEffect(1.15)
    }
  }

  @ViewBuilder private var actions: some View {
    switch state {
    case .ready:
      PrismPrimaryButton(title: "Open Circle", icon: "arrow.right") { finish() }
    case .failed:
      PrismSecondaryButton(title: "Back", icon: "chevron.left") { dismiss() }
    default:
      EmptyView()
    }
  }

  private var label: String {
    switch state {
    case .idle: return ""
    case .creating: return "Creating…"
    case .confirming: return "Confirming…"
    case .inviting: return "Adding everyone…"
    case .ready: return "Circle ready"
    case .failed: return "This Circle wasn't created"
    }
  }
}

/// A local confirmation for a Circle action that is not a payment.
///
/// Separate from `PaymentAuthorizationSheet` because that screen leads with an amount, and these
/// actions do not have one — leading with "$0.00" would be worse than saying what is actually
/// being authorized.
struct CircleAuthorizationSheet: View {
  let title: String
  let subtitle: String
  let detail: String
  let approve: (String?, Bool) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var pin = ""
  @State private var error: String?

  var body: some View {
    VStack(spacing: 0) {
      Capsule().fill(PrismTheme.line).frame(width: 38, height: 5).padding(.top, 10)

      ZStack {
        Circle().fill(PrismTheme.mintSoft).frame(width: 66, height: 66)
        Image(systemName: "checkmark.shield.fill")
          .font(.system(size: 24, weight: .medium))
          .foregroundStyle(PrismTheme.mintDeep)
      }
      .padding(.top, 26)
      .accessibilityHidden(true)

      Text(title)
        .font(PrismTheme.display(29))
        .tracking(-0.5)
        .padding(.top, 16)

      Text(subtitle)
        .font(PrismTheme.body(16, weight: .semibold))
        .padding(.top, 4)
        .multilineTextAlignment(.center)

      Text(detail)
        .font(PrismTheme.body(12.5))
        .foregroundStyle(PrismTheme.muted)
        .multilineTextAlignment(.center)
        .lineSpacing(2)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 26)
        .padding(.top, 8)

      if UserDefaults.standard.bool(forKey: "payments.faceID") {
        Button {
          dismiss()
          approve(nil, true)
        } label: {
          Label("Use Face ID", systemImage: "faceid")
            .font(PrismTheme.body(14.5, weight: .semibold))
            .frame(maxWidth: .infinity)
            .frame(height: 52)
        }
        .buttonStyle(.plain)
        .foregroundStyle(PrismTheme.mintDeep)
        .background(PrismTheme.mintSoft)
        .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
        .padding(.top, 20)

        HStack(spacing: 12) {
          Rectangle().fill(PrismTheme.line).frame(height: 1)
          Text("or PIN").font(PrismTheme.body(10.5, weight: .medium)).foregroundStyle(PrismTheme.muted)
          Rectangle().fill(PrismTheme.line).frame(height: 1)
        }
        .padding(.vertical, 18)
      } else {
        Spacer().frame(height: 22)
      }

      HStack(spacing: 13) {
        ForEach(0..<6, id: \.self) { index in
          Circle()
            .fill(index < pin.count ? PrismTheme.mintDeep : Color.clear)
            .overlay(Circle().stroke(index < pin.count ? PrismTheme.mintDeep : PrismTheme.faint, lineWidth: 1))
            .frame(width: 11, height: 11)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(pin.count) of 6 PIN digits entered")

      DigitPad(value: $pin, maxDigits: 6).padding(.top, 16)

      if let error {
        Text(error).font(PrismTheme.body(11.5)).foregroundStyle(PrismTheme.danger).padding(.top, 7)
      }

      Spacer(minLength: 12)

      PrismPrimaryButton(title: "Confirm", enabled: pin.count == 6, icon: "checkmark") {
        guard pin.count == 6 else {
          error = "Enter your six-digit payment PIN."
          return
        }
        let entered = pin
        dismiss()
        approve(entered, false)
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 18)
    .presentationDetents([.large])
    .presentationDragIndicator(.hidden)
    .prismScreen()
  }
}
