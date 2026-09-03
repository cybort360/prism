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

  func send<Body: Encodable, Response: Decodable>(
    _ path: String, method: String = "POST", body: Body?, idempotencyKey: String? = nil
  ) async throws -> Response {
    var req = URLRequest(url: baseURL.appending(path: path))
    req.httpMethod = method
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
    if let idempotencyKey { req.setValue(idempotencyKey, forHTTPHeaderField: "idempotency-key") }
    if let body { req.httpBody = try encoder.encode(body) }
    let (data, response) = try await session.data(for: req)
    guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
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
enum APIError: LocalizedError {
  case invalidResponse
  case server(String)
  var errorDescription: String? {
    switch self {
    case .invalidResponse: "Invalid response"
    case .server(let m): m
    }
  }
}
