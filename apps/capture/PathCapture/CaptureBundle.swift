import CryptoKit
import Foundation
import ImageIO

/// Read the recorder's saved files so a take can be packaged after an offline scan.
enum CaptureBundle {
  private struct Pose: Decodable {
    let t: Double
    let cameraToWorld: [Float]
    let tracking: String
    let intrinsics: [Float]?
    let imageWidth, imageHeight: Int?
  }
  private struct Keyframe: Decodable {
    let camera: Pose
    let jpeg: String
  }
  private struct Frame: Encodable {
    let id, imagePath: String
    let timestampSeconds: Double
    let width, height: Int
    let cameraPose: [Float]
    let intrinsics: Intrinsics?
  }
  private struct Intrinsics: Encodable {
    let fx, fy, cx, cy: Float
  }
  private struct FrameIndex: Encodable {
    let version = 1
    let captureId: String
    let frames: [Frame]
  }
  private struct FileEntry: Encodable {
    let path, sha256: String
    let byteSize: Int
  }
  private struct Manifest: Encodable {
    let version = 1
    let captureId, capturedAt: String
    let device: [String: String]
    let coordinateSystem = [
      "units": "metres", "upAxis": "Y", "handedness": "right",
      "matrixLayout": "column-major", "poseConvention": "camera-to-capture",
    ]
    let entrancePose: [Float]
    let files: [FileEntry]
    let trackingWarnings: [String]
  }
  struct Incomplete: LocalizedError {
    let errorDescription: String?
    init(_ reason: String) { errorDescription = reason }
  }

  static func write(take: URL, record: ScanRecord, to destination: URL) throws {
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
    guard keyframes.count <= 1000 else { throw Incomplete("Select at most 1,000 frames.") }
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
    func index(_ path: String) throws {
      let handle = try FileHandle(forReadingFrom: stage.appendingPathComponent(path))
      defer { try? handle.close() }
      var hash = SHA256()
      var size = 0
      while let block = try handle.read(upToCount: 1 << 20), !block.isEmpty {
        hash.update(data: block)
        size += block.count
      }
      let limit = path == "frames.json" ? (2 << 20) : (32 << 20)
      guard size > 0, size <= limit else { throw Incomplete("Empty or oversized file: \(path)") }
      let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
      files.append(FileEntry(path: path, sha256: digest, byteSize: size))
    }
    func include(_ path: String, from source: URL) throws {
      try fm.copyItem(at: source, to: stage.appendingPathComponent(path))
      try index(path)
    }
    try include("source.glb", from: take.appendingPathComponent("scene.glb"))
    try include("points.ply", from: take.appendingPathComponent("points.ply"))
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
      guard let image = CGImageSourceCreateWithURL(source as CFURL, nil),
        let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
        let width = properties[kCGImagePropertyPixelWidth] as? Int,
        let height = properties[kCGImagePropertyPixelHeight] as? Int,
        width > 0, height > 0, width <= 32768, height <= 32768
      else { throw Incomplete("Unreadable JPEG dimensions.") }
      var intrinsics: Intrinsics?
      if let k = keyframe.camera.intrinsics, k.count == 9,
        let originalWidth = keyframe.camera.imageWidth, originalWidth > 0,
        let originalHeight = keyframe.camera.imageHeight, originalHeight > 0 {
        let sx = Float(width) / Float(originalWidth), sy = Float(height) / Float(originalHeight)
        intrinsics = Intrinsics(fx: k[0] * sx, fy: k[4] * sy, cx: k[6] * sx, cy: k[7] * sy)
      }
      try include(path, from: source)
      if frames.isEmpty { try include("preview.jpg", from: source) }
      frames.append(
        Frame(
          id: frameId, imagePath: path, timestampSeconds: keyframe.camera.t,
          width: width, height: height, cameraPose: keyframe.camera.cameraToWorld,
          intrinsics: intrinsics))
    }
    let deviceID = record.id.uuidString.lowercased()
    try encoder.encode(FrameIndex(captureId: deviceID, frames: frames)).write(to: stage.appendingPathComponent("frames.json"))
    try index("frames.json")
    guard files.reduce(0, { $0 + $1.byteSize }) <= (256 << 20) else { throw Incomplete("Capture exceeds 256 MiB.") }
    var warnings = Set(poses.map(\.tracking)).subtracting(["normal"]).sorted().map {
      "tracking: " + $0
    }
    if record.partial { warnings.append("capture interrupted") }
    let device = [
      "model": record.deviceModel ?? "unknown (legacy scan)",
      "osVersion": record.deviceOSVersion ?? "unknown (legacy scan)",
    ]
    let manifest = Manifest(
      captureId: deviceID,
      capturedAt: ISO8601DateFormatter().string(from: record.created),
      device: device, entrancePose: entrance.cameraToWorld,
      files: files.sorted { $0.path < $1.path }, trackingWarnings: warnings)
    try encoder.encode(manifest).write(to: stage.appendingPathComponent("manifest.json"))
    try fm.moveItem(at: stage, to: destination)
  }
}
