import Foundation

/// Sam's standalone GLB endpoint creates a ready map and its containing space in one request.
struct HostedScanAPI {
  static let site = URL(string: "https://not404.vodka")!
  let origin: URL
  private let session: URLSession

  init(origin: URL = Self.site) {
    self.origin = origin
    let config = URLSessionConfiguration.ephemeral
    config.httpShouldSetCookies = false
    config.timeoutIntervalForResource = 15 * 60
    session = URLSession(configuration: config, delegate: NoUploadRedirects(), delegateQueue: nil)
  }

  struct Map: Decodable {
    let shareId: UUID
    let sharePath: String
    let name: String
    func link(on origin: URL) throws -> URL {
      let path = "/s/" + shareId.uuidString.lowercased()
      guard sharePath.lowercased() == path else { throw Failure.invalidResponse }
      return origin.appendingPathComponent("s").appendingPathComponent(shareId.uuidString.lowercased())
    }
  }
  private struct Maps: Decodable { let scans: [Map] }
  enum Failure: LocalizedError {
    case tooLarge, empty, login, invalidResponse, rejected(Int)
    var errorDescription: String? {
      switch self {
      case .tooLarge: return "This model exceeds the server’s 100 MiB limit."
      case .empty: return "This scan has no saved 3D model to upload."
      case .login: return "Sign in again to authorize uploads to Not 404."
      case .invalidResponse: return "The server did not return a valid map link."
      case .rejected(let code): return "The server couldn’t accept the request (HTTP \(code))."
      }
    }
  }

  static func checkSize(of file: URL) throws {
    guard let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0
      else { throw Failure.empty }
    guard size <= 100 * 1024 * 1024 else { throw Failure.tooLarge }
  }

  private func request(_ url: URL, token: String) -> URLRequest {
    var request = URLRequest(url: url)
    request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return request
  }

  private func decode<T: Decodable>(_ type: T.Type, from result: (Data, URLResponse)) throws -> T {
    guard let http = result.1 as? HTTPURLResponse else { throw Failure.invalidResponse }
    switch http.statusCode {
    case 200..<300:
      guard let value = try? JSONDecoder().decode(type, from: result.0) else { throw Failure.invalidResponse }
      return value
    case 401: throw Failure.login
    case 413: throw Failure.tooLarge
    default: throw Failure.rejected(http.statusCode)
    }
  }

  // If the connection dropped after the server committed the upload, its response may have been lost.
  func previousUpload(named name: String, token: String) async throws -> URL? {
    let req = request(origin.appendingPathComponent("api/scans/mine"), token: token)
    let maps = try decode(Maps.self, from: await session.data(for: req))
    return try maps.scans.first(where: { $0.name == name })?.link(on: origin)
  }

  func upload(file: URL, name: String, token: String) async throws -> URL {
    try Self.checkSize(of: file)
    var components = URLComponents(url: origin.appendingPathComponent("api/scans"), resolvingAgainstBaseURL: false)!
    components.queryItems = [
      URLQueryItem(name: "format", value: "glb"),
      URLQueryItem(name: "visibility", value: "unlisted"),
      URLQueryItem(name: "name", value: name),
    ]
    var req = request(components.url!, token: token)
    req.httpMethod = "POST"
    req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    let result = try decode(Map.self, from: await session.upload(for: req, fromFile: file))
    return try result.link(on: origin)
  }
}

private final class NoUploadRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
