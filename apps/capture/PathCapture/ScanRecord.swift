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
  var deviceModel: String?
  var deviceOSVersion: String?
  var walkID: UUID?
  var sectionNumber: Int?
  var walkEndReason: String?
  var depthPriority: Bool?
  /// Floor changes the barometer noticed during this section; nil when there is no barometer.
  var floorChanges: [FloorChange]?
  /// GPS and compass at the start of the walk, saved with its first section when the user asked for it.
  var entrance: EntranceTag?
  /// The hottest thermal state iOS reported during this section.
  var thermal: ThermalLevel?
  // Account-scoped receipts are independent of the local Mac recorder link.
  var hostedLinks: [String: URL]?
  var pendingHostedUploads: Set<String>?
  var hostedMapName: String { "iPhone scan " + id.uuidString.lowercased() }
  var guestURL: URL?
  var videoJob: UUID?
  var videoGuestURL: URL?
  var folder: URL { Self.library.appendingPathComponent(id.uuidString, isDirectory: true) }
  static var library: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Scans", isDirectory: true)
  }
  func archive() throws -> URL {
    try Self.zip(folder, name: "PathScan-" + id.uuidString + ".zip")
  }
  func bundleArchive() throws -> URL {
    let fm = FileManager.default
    let staging = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try fm.createDirectory(at: staging, withIntermediateDirectories: false)
    defer { try? fm.removeItem(at: staging) }
    let bundle = staging.appendingPathComponent("capture", isDirectory: true)
    try CaptureBundle.write(take: folder, record: self, to: bundle)
    return try Self.zip(bundle, name: "capture-" + id.uuidString.lowercased() + ".zip")
  }
  static func zip(_ folder: URL, name: String) throws -> URL {
    let coordinator = NSFileCoordinator(filePresenter: nil)
    let staging = FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
    let archive = staging.appendingPathComponent(name)
    var coordinatorError: NSError?
    var copyError: Error?
    coordinator.coordinate(readingItemAt: folder, options: .forUploading, error: &coordinatorError)
    { snapshot in
      do { try FileManager.default.copyItem(at: snapshot, to: archive) } catch { copyError = error }
    }
    if let issue = coordinatorError ?? copyError as NSError? { throw issue }
    return archive
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

struct WalkArchive: Encodable {
  struct Section: Encodable {
    let number: Int
    let scanID: UUID
    let path: String
    let partial: Bool
  }
  let walkID: UUID
  let coordinateFrame = "ARKit session world, metres, +Y up"
  let sections: [Section]

  static func prepare(_ records: [ScanRecord]) throws -> URL {
    guard let id = records.first?.walkID, records.allSatisfy({ $0.walkID == id && $0.sectionNumber != nil }) else {
      throw CocoaError(.fileReadCorruptFile)
    }
    let fm = FileManager.default
    let staging = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let root = staging.appendingPathComponent("Walk-" + id.uuidString)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: staging) }
    var sections = [Section]()
    for record in records.sorted(by: { ($0.sectionNumber ?? 0) < ($1.sectionNumber ?? 0) }) {
      let name = record.id.uuidString
      try fm.copyItem(at: record.folder, to: root.appendingPathComponent(name))
      sections.append(Section(number: record.sectionNumber!, scanID: record.id, path: name, partial: record.partial))
    }
    let index = WalkArchive(walkID: id, sections: sections)
    try JSONEncoder().encode(index).write(to: root.appendingPathComponent("walk.json"), options: .atomic)
    return try ScanRecord.zip(root, name: root.lastPathComponent + ".zip")
  }
}
