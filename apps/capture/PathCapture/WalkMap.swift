import Foundation
import simd

/// X/Z in the gravity-aligned AR session. A tile needs a real depth or feature hit.
struct WalkMap: Codable {
  static let tileWidth: Float = 0.25
  var tiles = Set<SIMD2<Int32>>()
  var tracks = [[SIMD2<Float>]]()
  var position: SIMD2<Float>?
  var heading: SIMD2<Float>?
  var distance: Float = 0
  var lastTimestamp: Double?
  var tracked = false

  mutating func observe(_ point: SIMD3<Float>, cameraHeight: Float) {
    guard point.y.isFinite, point.y <= cameraHeight + 0.35,
      abs(point.x) < 1000, abs(point.z) < 1000
    else { return }
    tiles.insert(
      SIMD2(Int32(floor(point.x / Self.tileWidth)), Int32(floor(point.z / Self.tileWidth))))
  }

  mutating func locate(_ here: SIMD2<Float>, forward: SIMD2<Float>, at time: Double, normal: Bool) {
    guard normal, here.x.isFinite, here.y.isFinite, time.isFinite else {
      tracked = false
      return
    }
    let elapsed = time - (lastTimestamp ?? time)
    let step = position.map { simd_distance(here, $0) } ?? 0
    if !tracked || elapsed > 1.5 || elapsed < 0 || step > max(1.5, Float(elapsed) * 3) {
      tracks.append([here])
    } else if let last = tracks.last?.last, simd_distance(last, here) >= 0.18 {
      distance += simd_distance(last, here)
      tracks[tracks.count - 1].append(here)
    }
    position = here
    if simd_length_squared(forward) > 0.01 { heading = simd_normalize(forward) }
    lastTimestamp = time
    tracked = true
  }

  mutating func include(_ other: WalkMap) {
    tiles.formUnion(other.tiles)
    tracks.append(contentsOf: other.tracks)
    distance += other.distance
    if other.position != nil {
      position = other.position
      heading = other.heading
      tracked = other.tracked
      lastTimestamp = other.lastTimestamp
    }
  }

  /// Seed the next section at the seam only when there is a tracked last pose.
  func nextSection() -> WalkMap {
    var next = WalkMap()
    if tracked, let position, let lastTimestamp {
      next.locate(position, forward: heading ?? .zero, at: lastTimestamp, normal: true)
    }
    return next
  }

  static func read(from directory: URL) throws -> WalkMap {
    try JSONDecoder().decode(
      Self.self, from: Data(contentsOf: directory.appendingPathComponent("walk-map.json")))
  }
  func write(to directory: URL) throws {
    try JSONEncoder().encode(self).write(
      to: directory.appendingPathComponent("walk-map.json"), options: .atomic)
  }
}

enum SectionBudget {
  static func shouldSave(seconds: Double, points: Int, faces: Int) -> Bool {
    seconds >= 35 || (seconds >= 8 && (points >= 150_000 || faces >= 100_000))
  }
}
