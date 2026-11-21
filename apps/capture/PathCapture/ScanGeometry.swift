import Foundation
import simd

// The native and guest viewers share ARKit's right-handed, Y-up world in metres.
struct SurfaceFace {
  let indices: SIMD3<Int32>
  let classification: UInt8
}
struct SurfaceChunk {
  var vertices: [SIMD3<Float>]
  var faces: [SurfaceFace]
}
struct ScanPhoto {
  let url: URL
  let worldToCamera: simd_float4x4
  let intrinsics: simd_float3x3
  let size: SIMD2<Float>
  let depth: [Float]
  let depthSize: SIMD2<Int>

  // Image coordinates refer to the unrotated camera buffer, the same as the JPEG.
  func project(_ point: SIMD3<Float>) -> (uv: SIMD2<Float>, distance: Float)? {
    let p = worldToCamera * SIMD4(point, 1)
    let z = -p.z
    guard z > 0.15, z < 7 else { return nil }
    let uv = SIMD2(
      (intrinsics[0].x * p.x / z + intrinsics[2].x) / size.x,
      (intrinsics[2].y - intrinsics[1].y * p.y / z) / size.y)
    guard uv.x > 0.012, uv.y > 0.012, uv.x < 0.988, uv.y < 0.988 else { return nil }
    if !depth.isEmpty {
      let measured = depth[
        Int(uv.y * Float(depthSize.y)) * depthSize.x + Int(uv.x * Float(depthSize.x))]
      guard measured.isFinite, measured > 0, abs(measured - z) < max(0.12, z * 0.06) else {
        return nil
      }
    }
    return (uv, z)
  }
}

struct ScanVertex {
  var p: SIMD3<Float>
  var color: SIMD3<UInt8>
  var uv: SIMD2<Float>
}

struct MeshExport {
  var triangles = 0
  var texturedTriangles = 0
  var classes: [String: Int] = [:]
}

struct NativeGLB {
  private var binary = Data()
  private var views: [[String: Any]] = []
  private var accessors: [[String: Any]] = []

  private mutating func view(_ bytes: Data) -> Int {
    while !binary.count.isMultiple(of: 4) { binary.append(0) }
    views.append(["buffer": 0, "byteOffset": binary.count, "byteLength": bytes.count])
    binary.append(bytes)
    return views.count - 1
  }
  private mutating func attribute(
    _ data: Data, type: String, count: Int, bytes: Bool = false,
    minimum: [Float]? = nil, maximum: [Float]? = nil
  ) -> Int {
    var entry: [String: Any] = [
      "bufferView": view(data), "componentType": bytes ? 5121 : 5126, "count": count, "type": type,
    ]
    if bytes { entry["normalized"] = true }
    if let minimum, let maximum {
      entry["min"] = minimum
      entry["max"] = maximum
    }
    accessors.append(entry)
    return accessors.count - 1
  }
  static let labels = [
    "unclassified", "wall", "floor", "ceiling", "table", "seat", "window", "door",
  ]
  static func label(_ raw: UInt8) -> String {
    Int(raw) < labels.count ? labels[Int(raw)] : labels[0]
  }

  mutating func write(chunks: [SurfaceChunk], cloud: PointCloud, photos: [ScanPhoto], to url: URL)
    throws -> MeshExport
  {
    var result = MeshExport()
    var groups: [Int: [ScanVertex]] = [:]  // Photo number; -1 holds surfaces with no supported photo.
    for chunk in chunks {
      for f in chunk.faces {
        let ids = [Int(f.indices.x), Int(f.indices.y), Int(f.indices.z)]
        guard ids.allSatisfy(chunk.vertices.indices.contains) else { continue }
        let a = chunk.vertices[ids[0]]
        let b = chunk.vertices[ids[1]]
        let c = chunk.vertices[ids[2]]
        let normal = simd_cross(b - a, c - a)
        guard simd_length_squared(normal) > 1e-12 else { continue }
        let center = (a + b + c) / 3
        var chosen = -1
        var score: Float = 0
        var uvs = [SIMD2<Float>](repeating: .zero, count: 3)
        for (n, photo) in photos.enumerated() {
          guard let mid = photo.project(center) else { continue }
          let centrality = 1 - simd_length(mid.uv - 0.5)
          guard let pa = photo.project(a), let pb = photo.project(b), let pc = photo.project(c)
          else { continue }
          let e1 = pb.uv - pa.uv
          let e2 = pc.uv - pa.uv
          let weight = abs(e1.x * e2.y - e1.y * e2.x) * centrality
          if weight > score {
            score = weight
            chosen = n
            uvs = [pa.uv, pb.uv, pc.uv]
          }
        }
        for (i, p) in [a, b, c].enumerated() {
          let color = chosen < 0 ? cloud.nearbyColor(p) : SIMD3<UInt8>(repeating: 255)
          groups[chosen, default: []].append(ScanVertex(p: p, color: color, uv: uvs[i]))
        }
        result.triangles += 1
        result.classes[Self.label(f.classification), default: 0] += 1
        if chosen >= 0 { result.texturedTriangles += 1 }
      }
    }
    if groups.isEmpty {
      groups[-1] = cloud.points.map { ScanVertex(p: $0.position, color: $0.color, uv: .zero) }
    }
    guard groups.values.contains(where: { !$0.isEmpty }) else { throw ScanFailure.empty }
    var primitives: [[String: Any]] = []
    var images: [[String: Any]] = []
    var textures: [[String: Any]] = []
    var materials: [[String: Any]] = []
    for n in groups.keys.sorted() {
      guard let verts = groups.removeValue(forKey: n), !verts.isEmpty else { continue }
      var xyz = Data()
      var rgb = Data()
      var uv = Data()
      xyz.reserveCapacity(verts.count * 12)
      var low = verts[0].p
      var high = low
      for v in verts {
        for i in 0..<3 {
          xyz.appendLE(v.p[i].bitPattern)
          rgb.append(v.color[i])
        }
        rgb.append(255)
        if n >= 0 {
          uv.appendLE(v.uv.x.bitPattern)
          uv.appendLE(v.uv.y.bitPattern)
        }
        low = simd_min(low, v.p)
        high = simd_max(high, v.p)
      }
      let pos = attribute(
        xyz, type: "VEC3", count: verts.count, minimum: [low.x, low.y, low.z],
        maximum: [high.x, high.y, high.z])
      var attrs = ["POSITION": pos]
      var pbr: [String: Any] = ["metallicFactor": 0, "roughnessFactor": 1]
      if n >= 0 {
        let iv = view(try Data(contentsOf: photos[n].url))
        images.append(["bufferView": iv, "mimeType": "image/jpeg"])
        textures.append(["source": images.count - 1])
        pbr["baseColorTexture"] = ["index": textures.count - 1]
        attrs["TEXCOORD_0"] = attribute(uv, type: "VEC2", count: verts.count)
      } else {
        attrs["COLOR_0"] = attribute(rgb, type: "VEC4", count: verts.count, bytes: true)
      }
      materials.append([
        "pbrMetallicRoughness": pbr, "doubleSided": true,
        "extensions": ["KHR_materials_unlit": [String: Any]()],
      ])
      primitives.append([
        "attributes": attrs, "material": materials.count - 1, "mode": result.triangles > 0 ? 4 : 0,
      ])
    }
    var gltf: [String: Any] = [
      "asset": ["version": "2.0", "generator": "Path Capture"], "scene": 0,
      "scenes": [["nodes": [0]]], "nodes": [["mesh": 0]], "meshes": [["primitives": primitives]],
      "materials": materials, "extensionsUsed": ["KHR_materials_unlit"], "accessors": accessors,
      "bufferViews": views, "buffers": [["byteLength": binary.count]],
    ]
    if !images.isEmpty {
      gltf["images"] = images
      gltf["textures"] = textures
    }
    var json = try JSONSerialization.data(withJSONObject: gltf)
    while !json.count.isMultiple(of: 4) { json.append(32) }
    while !binary.count.isMultiple(of: 4) { binary.append(0) }
    var output = Data()
    output.appendLE(UInt32(0x4654_6c67))
    output.appendLE(UInt32(2))
    output.appendLE(UInt32(28 + json.count + binary.count))
    output.appendLE(UInt32(json.count))
    output.appendLE(UInt32(0x4e4f_534a))
    output.append(json)
    output.appendLE(UInt32(binary.count))
    output.appendLE(UInt32(0x004e_4942))
    output.append(binary)
    try output.write(to: url, options: .atomic)
    return result
  }
}
extension Data {
  mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
    Swift.withUnsafeBytes(of: value.littleEndian) { append(contentsOf: $0) }
  }
}
enum ScanFailure: LocalizedError {
  case empty, cameraVideo, badPair, tooLarge
  var errorDescription: String? {
    switch self {
    case .empty:
      return "No geometry was recorded. Keep a textured feature in view until tracking is normal."
    case .cameraVideo: return "The camera video could not be saved."
    case .badPair: return "Scan or paste the HTTPS organizer link from the Mac pairing page."
    case .tooLarge:
      return "This scan exceeds the local mesh budget. Save this section and start another."
    }
  }
}
