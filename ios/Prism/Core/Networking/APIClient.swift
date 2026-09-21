import Foundation

struct EmptyBody: Encodable {}

actor APIClient {
  static let shared = APIClient()
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()
  private let session = URLSession(configuration: .ephemeral)
  private var token: String? { try? KeychainStore.shared.string(for: "session") }
  private var baseURL: URL {
    let configured = Bundle.main.object(forInfoDictionaryKey: "PRISM_API_BASE_URL") as? String
    let candidate = configured?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let raw = candidate.isEmpty || candidate.contains("$(") ? "http://127.0.0.1:8787" : candidate
    guard let url = URL(string: raw), let scheme = url.scheme, ["http", "https"].contains(scheme) else {
      preconditionFailure("PRISM_API_BASE_URL must be an absolute http(s) URL")
    }
    return url
  }

  func request<Response: Decodable>(_ path: String, method: String = "GET") async throws -> Response
  {
    try await send(path, method: method, body: Optional<EmptyBody>.none)
  }

  /// Build the request URL from a path that MAY carry a query string ("/x?a=1&b=2"). Splitting is
  /// required: `URL.appending(path:)` treats the whole string as one path segment and percent-encodes
  /// the "?" into "%3F", so "/v1/circles/templates?template=TRIP" would miss its route and 404.
  private func url(for path: String) -> URL {
    guard let q = path.firstIndex(of: "?") else { return baseURL.appending(path: path) }
    let base = baseURL.appending(path: String(path[..<q]))
    let query = String(path[path.index(after: q)...])
    guard !query.isEmpty, var comps = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return base }
    comps.percentEncodedQuery = query
    return comps.url ?? base
  }

  func send<Body: Encodable, Response: Decodable>(
    _ path: String, method: String = "POST", body: Body?, idempotencyKey: String? = nil
  ) async throws -> Response {
    var req = URLRequest(url: url(for: path))
    req.httpMethod = method
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
    if let idempotencyKey { req.setValue(idempotencyKey, forHTTPHeaderField: "idempotency-key") }
    if let body { req.httpBody = try encoder.encode(body) }
    let (data, response) = try await session.data(for: req)
    guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
    // A 401 on an authed route means the session is missing or expired. Don't surface it as a raw
    // "missing session" error everywhere — signal the app to end the session and re-authenticate.
    if http.statusCode == 401 {
      NotificationCenter.default.post(name: .prismUnauthorized, object: nil)
      throw APIError.unauthorized
    }
    guard 200..<300 ~= http.statusCode else {
      let message =
        (try? decoder.decode(ErrorEnvelope.self, from: data).error) ?? "HTTP \(http.statusCode)"
      throw APIError.server(message)
    }
    do {
      return try decoder.decode(Response.self, from: data)
    } catch let DecodingError.keyNotFound(key, ctx) {
      throw APIError.server("Missing '\(key.stringValue)' in \(Response.self) at \(pathString(ctx.codingPath)) [\(path)]")
    } catch let DecodingError.valueNotFound(_, ctx) {
      throw APIError.server("Null value in \(Response.self) at \(pathString(ctx.codingPath)) [\(path)]")
    } catch let DecodingError.typeMismatch(_, ctx) {
      throw APIError.server("Type mismatch in \(Response.self) at \(pathString(ctx.codingPath)) [\(path)]")
    } catch {
      throw APIError.server("Could not read \(Response.self) from \(path)")
    }
  }

  private func pathString(_ codingPath: [CodingKey]) -> String {
    let joined = codingPath.map(\.stringValue).joined(separator: ".")
    return joined.isEmpty ? "root" : joined
  }
}
private struct ErrorEnvelope: Decodable { let error: String }
extension Notification.Name { static let prismUnauthorized = Notification.Name("prism.unauthorized") }
enum APIError: LocalizedError {
  case invalidResponse
  case unauthorized
  case server(String)
  var errorDescription: String? {
    switch self {
    case .invalidResponse: "Invalid response"
    case .unauthorized: "Your session ended. Please sign in again."
    case .server(let m): m
    }
  }
}
