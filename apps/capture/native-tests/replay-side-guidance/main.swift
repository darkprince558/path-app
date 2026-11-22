// Feed saved keyframes to the phone's detector in recording order, without RGB or mesh data.
// Usage: swiftc -O PathCapture/SideGuidance.swift native-tests/replay-side-guidance/main.swift -o /tmp/replay
//        /tmp/replay /path/to/Scans
import Foundation
import simd

struct Section: Decodable {
  let walkID: UUID?
  let created: Double
  let sectionNumber: Int?
}
struct Pose: Decodable {
  let t: Double
  let tracking: String
  let imageWidth, imageHeight: Float
  let cameraToWorld, intrinsics: [Float]
}
struct Keyframe: Decodable {
  let camera: Pose
  let depthWidth, depthHeight: Int?
  let depthMetersFloat32LE, confidenceUInt8: String?
}
func read<T: Decodable>(_ file: URL) throws -> T {
  try JSONDecoder().decode(T.self, from: Data(contentsOf: file))
}

func observe(_ key: Keyframe, in folder: URL) throws -> SideObservation {
  guard let w = key.depthWidth, let h = key.depthHeight, let d = key.depthMetersFloat32LE,
        let c = key.confidenceUInt8 else { return SideObservation() }
  let depth = try Data(contentsOf: folder.appendingPathComponent(d))
  let confidence = try Data(contentsOf: folder.appendingPathComponent(c))
  let pose = key.camera, k = pose.intrinsics, m = pose.cameraToWorld
  guard depth.count == 4*w*h, confidence.count == w*h, m.count == 16, k.count == 9 else {
    throw CocoaError(.fileReadCorruptFile)
  }
  let sx = Float(w) / pose.imageWidth, sy = Float(h) / pose.imageHeight
  func column(_ start: Int) -> SIMD4<Float> { SIMD4(m[start], m[start+1], m[start+2], m[start+3]) }
  return depth.withUnsafeBytes { raw in
    confidence.withUnsafeBytes { (conf: UnsafeRawBufferPointer) in
      SideObservation.sample(width: w, height: h, focal: SIMD2(k[0]*sx, k[4]*sy),
        center: SIMD2(k[6]*sx, k[7]*sy), camera: simd_float4x4(columns: (column(0), column(4), column(8), column(12)))) { x,y in
          let i = y*w+x
          guard (1...2).contains(conf[i]) else { return nil }
          return Float(bitPattern: UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: 4*i, as: UInt32.self)))
        }
    }
  }
}

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let files = FileManager.default
var walks = [UUID: [(section: Section, folder: URL)]]()
for folder in try files.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
  let manifest = folder.appendingPathComponent("scan.json")
  guard files.fileExists(atPath: manifest.path) else { continue }
  let section: Section = try read(manifest)
  if let walk = section.walkID { walks[walk, default: []].append((section, folder)) }
}
for (id, sections) in walks.sorted(by: { $0.key.uuidString < $1.key.uuidString }) {
  let sorted = sections.sorted { ($0.section.sectionNumber ?? 0) < ($1.section.sectionNumber ?? 0) }
  var detector = SideGuidance(), count = 0
  let start = sorted[0].section.created
  var active: RescanSide?, since = 0.0, end = 0.0
  func record(_ cue: RescanSide?, at time: Double) {
    if active == cue { return }
    if let active { print(String(format: "  %@ %.1f %.1f", active.rawValue, since, time)) }
    active = cue
    since = time
  }
  print("Walk", id.uuidString.prefix(8))
  for (section, folder) in sorted {
    let offset = section.created - start
    let poses: [Pose] = try read(folder.appendingPathComponent("camera-poses.json"))
    let keys: [Keyframe] = try read(folder.appendingPathComponent("keyframes.json"))
    var next = 0
    for pose in poses {
      if pose.tracking != "normal" {
        detector = SideGuidance()
        record(nil, at: offset + pose.t)
      }
      while next < keys.count && keys[next].camera.t <= pose.t {
        let key = keys[next], camera = key.camera, m = camera.cameraToWorld
        next += 1
        if camera.tracking == "normal" && pose.tracking == "normal" {
          let frame = try observe(key, in: folder)
          detector.update(position: SIMD3(m[12], m[13], m[14]), at: offset + camera.t, frame: frame)
          record(detector.cue, at: offset + camera.t)
        }
        count += 1
      }
    }
    precondition(next == keys.count, "Depth frame has no matching recorded pose")
    end = offset + (poses.last?.t ?? 0)
  }
  record(nil, at: end)
  print("  frames", count)
}
