import CryptoKit
import Foundation

/// Read the recorder's saved files so a take can be packaged after an offline scan.
enum CaptureBundle {
  private struct Pose: Decodable {
    let t: Double
    let cameraToWorld: [Float]
    let tracking: String
  }
  private struct Keyframe: Decodable {
    let camera: Pose
    let jpeg: String
  }
  private struct Frame: Encodable {
    let frameId, path: String
    let timestampMs: Int
    let cameraPose: [Float]
  }
  private struct FileEntry: Encodable {
    let path, type, sha256: String
    let byteSize: Int
  }
  private struct Manifest: Encodable {
    let version = "1.0"
    let captureId, createdAt: String
    let device: [String: String]
    let coordinateSystem = [
      "units": "meters", "upAxis": "Y", "handedness": "right", "matrixOrder": "column-major",
    ]
    let entrancePose: [Float]
    let files: [FileEntry]
    let trackingWarnings: [String]
  }
  struct Incomplete: LocalizedError {
    let errorDescription: String?
    init(_ reason: String) { errorDescription = reason }
  }

  static func write(take: URL, record: ScanRecord, captureID: UUID, to destination: URL) throws {
    guard record.triangles > 0, record.pointCount > 0 else {
      throw Incomplete("A LiDAR bundle needs a surface mesh and colored points.")
    }
    let fm = FileManager.default
    let decoder = JSONDecoder()
    func read<T: Decodable>(_ name: String, as: T.Type) throws -> T {
      try decoder.decode(T.self, from: Data(contentsOf: take.appendingPathComponent(name)))
    }
    let poses = try read("camera-poses.json", as: [Pose].self)
    let keyframes = try read("keyframes.json", as: [Keyframe].self)
    guard let entrance = poses.first(where: { $0.tracking == "normal" }), !keyframes.isEmpty else {
      throw Incomplete("This scan needs a tracked starting pose and at least one camera photo.")
    }
    let stage = destination.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
    try fm.createDirectory(at: stage, withIntermediateDirectories: false)
    defer { try? fm.removeItem(at: stage) }
    try fm.createDirectory(
      at: stage.appendingPathComponent("frames"), withIntermediateDirectories: false)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    var files: [FileEntry] = []
    func index(_ path: String, _ type: String) throws {
      let handle = try FileHandle(forReadingFrom: stage.appendingPathComponent(path))
      defer { try? handle.close() }
      var hash = SHA256()
      var size = 0
      while let block = try handle.read(upToCount: 1 << 20), !block.isEmpty {
        hash.update(data: block)
        size += block.count
      }
      guard size > 0 else { throw Incomplete("Empty file: \(path)") }
      let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
      files.append(FileEntry(path: path, type: type, sha256: digest, byteSize: size))
    }
    func include(_ path: String, _ type: String, from source: URL) throws {
      try fm.copyItem(at: source, to: stage.appendingPathComponent(path))
      try index(path, type)
    }
    try include("source.glb", "mesh", from: take.appendingPathComponent("scene.glb"))
    try include("points.ply", "pointcloud", from: take.appendingPathComponent("points.ply"))
    var frames: [Frame] = []
    for keyframe in keyframes {
      let jpeg = keyframe.jpeg
      guard jpeg.hasPrefix("photo-"), jpeg.hasSuffix(".jpg"),
        let number = Int(jpeg.dropFirst(6).dropLast(4)), number >= 0,
        jpeg == "photo-\(number).jpg", keyframe.camera.tracking == "normal"
      else { throw Incomplete("Unrecognized saved camera frame.") }
      let frameId = String(format: "frame-%04ld", number)
      let path = "frames/\(frameId).jpg"
      let source = take.appendingPathComponent(jpeg)
      try include(path, "camera_frame", from: source)
      if frames.isEmpty { try include("preview.jpg", "preview", from: source) }
      frames.append(
        Frame(
          frameId: frameId, path: path,
          timestampMs: Int((keyframe.camera.t * 1000).rounded()),
          cameraPose: keyframe.camera.cameraToWorld))
    }
    try encoder.encode(["frames": frames]).write(to: stage.appendingPathComponent("frames.json"))
    try index("frames.json", "frame_metadata")
    var warnings = Set(poses.map(\.tracking)).subtracting(["normal"]).sorted().map {
      "tracking: " + $0
    }
    if record.partial { warnings.append("capture interrupted") }
    let device = [
      "model": record.deviceModel ?? "unknown (legacy scan)", "platform": "iOS", "scanner": "ARKit",
    ]
    let manifest = Manifest(
      captureId: captureID.uuidString.lowercased(),
      createdAt: ISO8601DateFormatter().string(from: record.created),
      device: device, entrancePose: entrance.cameraToWorld,
      files: files.sorted { $0.path < $1.path }, trackingWarnings: warnings)
    try encoder.encode(manifest).write(to: stage.appendingPathComponent("manifest.json"))
    try fm.moveItem(at: stage, to: destination)
  }
}
