import Foundation

struct ScanRecord: Codable, Identifiable {
  let id: UUID
  let created: Date
  let duration: Double
  let mode: String
  var pointCount, triangles, photoFaces, poseCount, gyroCount: Int
  var classes: [String: Int]
  let hasVideo: Bool
  var partial: Bool
  var guestURL: URL?
  var videoJob: UUID?
  var videoGuestURL: URL?
  var folder: URL { Self.library.appendingPathComponent(id.uuidString, isDirectory: true) }
  static var library: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Scans", isDirectory: true)
  }
  func persist() throws {
    try JSONEncoder().encode(self).write(
      to: folder.appendingPathComponent("scan.json"), options: .atomic)
  }
  static func all() -> [Self] {
    let dirs =
      (try? FileManager.default.contentsOfDirectory(at: library, includingPropertiesForKeys: nil))
      ?? []
    return dirs.compactMap {
      try? JSONDecoder().decode(
        Self.self, from: Data(contentsOf: $0.appendingPathComponent("scan.json")))
    }.sorted { $0.created > $1.created }
  }
}
