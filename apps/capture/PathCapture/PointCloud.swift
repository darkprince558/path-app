import Foundation
import simd

struct PointCloud {
  struct Point {
    let position: SIMD3<Float>
    let color: SIMD3<UInt8>
  }

  private static let cellSize: Float = 0.035
  private static let maxPoints = 300_000

  private var occupied: [SIMD3<Int32>: Int] = [:]
  private(set) var points: [Point] = []

  var count: Int { points.count }
  var isFull: Bool { count == Self.maxPoints }

  static func unproject(
    x: Float, y: Float, depth: Float,
    intrinsics: simd_float3x3, cameraToWorld: simd_float4x4
  ) -> SIMD3<Float> {
    // Camera pixels go right and down. ARKit camera space goes right, up, and back.
    let cameraPoint = SIMD4(
      (x - intrinsics[2][0]) * depth / intrinsics[0][0],
      -(y - intrinsics[2][1]) * depth / intrinsics[1][1],
      -depth,
      1
    )
    let world = cameraToWorld * cameraPoint
    return SIMD3(world.x, world.y, world.z)
  }

  mutating func add(_ position: SIMD3<Float>, color: SIMD3<UInt8>) {
    // This capture is local to one venue section. Discard invalid or runaway poses.
    guard !isFull, abs(position.x) < 1_000, abs(position.y) < 1_000,
      abs(position.z) < 1_000
    else { return }

    let cell = SIMD3(
      Int32(floor(position.x / Self.cellSize)),
      Int32(floor(position.y / Self.cellSize)),
      Int32(floor(position.z / Self.cellSize))
    )
    if occupied[cell] == nil {
      occupied[cell] = points.count
      points.append(Point(position: position, color: color))
    }
  }

  func nearbyColor(_ p: SIMD3<Float>) -> SIMD3<UInt8> {
    guard abs(p.x) < 1000, abs(p.y) < 1000, abs(p.z) < 1000 else { return SIMD3(repeating: 170) }
    let cell = SIMD3<Int32>(floor(p / Self.cellSize))
    if let i = occupied[cell] { return points[i].color }
    var nearest: (Float, SIMD3<UInt8>)?
    for z in -1...1 {
      for y in -1...1 {
        for x in -1...1 {
          let neighbor = cell &+ SIMD3(Int32(x), Int32(y), Int32(z))
          if let i = occupied[neighbor] {
            let d = simd_distance_squared(p, points[i].position)
            if d < (nearest?.0 ?? .infinity) { nearest = (d, points[i].color) }
          }
        }
      }
    }
    return nearest?.1 ?? SIMD3(repeating: 170)
  }

  func binaryPLY() -> Data {
    let header = """
      ply
      format binary_little_endian 1.0
      comment Path App scan-local frame in meters, +Y up
      element vertex \(count)
      property float x
      property float y
      property float z
      property uchar red
      property uchar green
      property uchar blue
      end_header

      """
    var output = Data(header.utf8)
    output.reserveCapacity(output.count + count * 15)
    for point in points {
      for axis in 0..<3 {
        let bits = point.position[axis].bitPattern.littleEndian
        withUnsafeBytes(of: bits) { output.append(contentsOf: $0) }
      }
      output.append(point.color.x)
      output.append(point.color.y)
      output.append(point.color.z)
    }
    return output
  }
}
