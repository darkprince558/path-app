import Foundation
import Security
import SwiftUI

struct MacAddress: Codable {
  let origin: URL
  let key: String
  init(_ string: String) throws {
    guard var c = URLComponents(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
      c.scheme?.lowercased() == "https", let host = c.host, c.user == nil, c.password == nil,
      c.query == nil, ["/record", "/record/"].contains(c.path), let fragment = c.fragment
    else { throw ScanFailure.badPair }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    let octets = labels.compactMap { part -> UInt8? in
      guard let value = UInt8(part), String(value) == part else { return nil }
      return value
    }
    let localIP =
      labels.count == 4 && octets.count == 4
      && (octets[0] == 10 || (octets[0] == 192 && octets[1] == 168)
        || (octets[0] == 172 && (16...31).contains(octets[1])))
    guard host.lowercased().hasSuffix(".local") || localIP, fragment.hasPrefix("key=") else {
      throw ScanFailure.badPair
    }
    let token = String(fragment.dropFirst(4))
    guard (32...128).contains(token.utf8.count),
      token.utf8.allSatisfy({
        (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45
          || $0 == 95
      })
    else { throw ScanFailure.badPair }
    c.path = ""
    c.fragment = nil
    guard let url = c.url else { throw ScanFailure.badPair }
    origin = url
    key = token
  }
  private static var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "PathCapture.Organizer", kSecAttrAccount as String: "local-mac",
    ]
  }
  func save() throws {
    let data = try JSONEncoder().encode(self)
    let attrs =
      [
        kSecValueData as String: data,
        kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      ] as [String: Any]
    let q = Self.query
    var status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(q.merging(attrs) { _, new in new } as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }
  }
  static func load() -> Self? {
    var q = query
    q[kSecReturnData as String] = true
    var item: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let d = item as? Data
    else { return nil }
    return try? JSONDecoder().decode(Self.self, from: d)
  }
  func guest(_ path: String) throws -> URL {
    guard path.range(of: "^/s/[a-f0-9]{32}$", options: .regularExpression) != nil else {
      throw ScanFailure.badPair
    }
    return origin.appendingPathComponent(String(path.dropFirst()))
  }
}
private final class DirectConnection: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}
struct ServerStatus: Decodable {
  let status: String
  let sharePath: String?
  let stage: String?
  let error: String?
}
struct MacClient {
  let mac: MacAddress
  private static let session: URLSession = {
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 90
    cfg.urlCache = nil
    return URLSession(configuration: cfg, delegate: DirectConnection(), delegateQueue: nil)
  }()
  func request(_ path: String, method: String = "GET", file: URL? = nil, mime: String? = nil)
    async throws -> ServerStatus
  {
    var req = URLRequest(url: mac.origin.appendingPathComponent(path))
    req.httpMethod = method
    req.setValue("Bearer " + mac.key, forHTTPHeaderField: "Authorization")
    req.setValue(mime, forHTTPHeaderField: "Content-Type")
    let data: Data
    let response: URLResponse
    if let file {
      (data, response) = try await Self.session.upload(for: req, fromFile: file)
    } else {
      (data, response) = try await Self.session.data(for: req)
    }
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      throw NSError(
        domain: "PathMac", code: (response as? HTTPURLResponse)?.statusCode ?? 0,
        userInfo: [
          NSLocalizedDescriptionKey: body?["error"] as? String
            ?? "The Mac could not accept this scan."
        ])
    }
    return try JSONDecoder().decode(ServerStatus.self, from: data)
  }
  func publish(_ r: ScanRecord) async throws -> URL {
    let result = try await request(
      "api/native-scans/" + r.id.uuidString.lowercased(), method: "PUT",
      file: r.folder.appendingPathComponent("scene.glb"), mime: "model/gltf-binary")
    return try mac.guest(result.sharePath ?? "")
  }
  func beginVideo(_ r: ScanRecord, id: UUID) async throws -> ServerStatus {
    let prefix = "api/captures/" + id.uuidString.lowercased()
    _ = try await request(
      prefix + "/video", method: "PUT", file: r.folder.appendingPathComponent("camera.mp4"),
      mime: "video/mp4")
    _ = try await request(
      prefix + "/motion", method: "PUT", file: r.folder.appendingPathComponent("motion.json"),
      mime: "application/json")
    return try await request(prefix + "/process", method: "POST")
  }
}
