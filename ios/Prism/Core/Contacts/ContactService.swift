import Contacts
import Foundation

final class ContactService: @unchecked Sendable {
  static let shared = ContactService()
  private let store = CNContactStore()
  private init() {}

  var authorizationStatus: CNAuthorizationStatus {
    CNContactStore.authorizationStatus(for: .contacts)
  }

  func requestAccess() async throws -> Bool {
    try await store.requestAccess(for: .contacts)
  }

  func contacts() async throws -> [ContactPerson] {
    let store = self.store
    return try await Task.detached(priority: .userInitiated) {
      let keys: [CNKeyDescriptor] = [
        CNContactIdentifierKey as CNKeyDescriptor,
        CNContactGivenNameKey as CNKeyDescriptor,
        CNContactFamilyNameKey as CNKeyDescriptor,
        CNContactPhoneNumbersKey as CNKeyDescriptor,
      ]
      let request = CNContactFetchRequest(keysToFetch: keys)
      request.sortOrder = .userDefault
      var result: [ContactPerson] = []
      try store.enumerateContacts(with: request) { contact, _ in
        guard
          let raw = contact.phoneNumbers.first?.value.stringValue,
          let phone = Self.normalize(raw)
        else { return }
        let name = [contact.givenName, contact.familyName]
          .filter { !$0.isEmpty }
          .joined(separator: " ")
        let initials = [contact.givenName.first, contact.familyName.first]
          .compactMap { $0 }
          .map(String.init)
          .joined()
        result.append(
          ContactPerson(
            id: contact.identifier,
            name: name.isEmpty ? phone : name,
            phone: phone,
            initials: initials.isEmpty ? "?" : initials
          )
        )
      }
      return result
    }.value
  }

  static func normalize(_ raw: String) -> String? {
    let digits = raw.filter { $0.isNumber }
    if raw.trimmingCharacters(in: .whitespaces).hasPrefix("+") {
      let value = "+\(digits)"
      return value.count >= 9 && value.count <= 16 ? value : nil
    }
    // Nigerian local form with the trunk 0 (e.g. 0803 123 4567). Kept for pasted/contact numbers.
    if digits.count == 11, digits.first == "0" {
      return "+234\(digits.dropFirst())"
    }
    // A number stored as 234… without the + (common in device contacts).
    if digits.count == 13, digits.hasPrefix("234") {
      return "+\(digits)"
    }
    // Local mobile without the trunk 0 — what the +234 prefix in the UI implies (e.g. 803 123 4567).
    if digits.count == 10, let first = digits.first, "789".contains(first) {
      return "+234\(digits)"
    }
    return nil
  }
}
