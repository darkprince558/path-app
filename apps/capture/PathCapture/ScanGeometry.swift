import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
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
extension SurfaceChunk {
  /// Dense ARKit surfaces repeat vertices within centimetres. Cluster within each
  /// anchor before texturing, retaining face winding and skipping collapsed faces.
  func clustered(cell: Float) -> SurfaceChunk {
    var slots = [SIMD3<Int32>: Int32]()
    var remap = [Int32](), sums = [SIMD3<Float>](), counts = [Int]()
    remap.reserveCapacity(vertices.count)
    for p in vertices {
      // Reject unusable sensor coordinates before converting to integers.
      guard abs(p.x) < 1000, abs(p.y) < 1000, abs(p.z) < 1000 else {
        remap.append(-1)
        continue
      }
      let key = SIMD3<Int32>(floor(p / cell))
      let index: Int32
      if let existing = slots[key] {
        index = existing
        sums[Int(index)] += p
        counts[Int(index)] += 1
      } else {
        index = Int32(sums.count)
        slots[key] = index
        sums.append(p)
        counts.append(1)
      }
      remap.append(index)
    }
    let positions = zip(sums, counts).map { $0 / Float($1) }
    var seen = Set<SIMD3<Int32>>()
    var result = [SurfaceFace]()
    for f in faces {
      let src = f.indices
      guard [src.x, src.y, src.z].allSatisfy({ remap.indices.contains(Int($0)) }) else { continue }
      let a = remap[Int(src.x)], b = remap[Int(src.y)], c = remap[Int(src.z)]
      guard min(a,b,c) >= 0, a != b, a != c, b != c else { continue }
      // Match cyclic duplicates without sorting away winding or overflowing Int32.
      let key = a < b && a < c ? SIMD3(a,b,c) : (b < c ? SIMD3(b,c,a) : SIMD3(c,a,b))
      if seen.insert(key).inserted { result.append(SurfaceFace(indices: SIMD3(a,b,c), classification: f.classification)) }
    }
    return SurfaceChunk(vertices: positions, faces: result)
  }
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
    guard depthSize.x > 0, depthSize.y > 0, depth.count / depthSize.x == depthSize.y else {
      return nil
    }
    let measured = depth[
      Int(uv.y * Float(depthSize.y)) * depthSize.x + Int(uv.x * Float(depthSize.x))]
    guard measured.isFinite, measured > 0, abs(measured - z) < max(0.12, z * 0.06) else {
      return nil
    }
    return (uv, z)
  }
}

struct ScanVertex {
  var p: SIMD3<Float>
  var color: SIMD3<UInt8>
  var classification: UInt8 = 0
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
    _ data: Data, type: String, count: Int, bytes: Bool = false, normalized: Bool = true,
    minimum: [Float]? = nil, maximum: [Float]? = nil
  ) -> Int {
    var entry: [String: Any] = [
      "bufferView": view(data), "componentType": bytes ? 5121 : 5126, "count": count, "type": type,
    ]
    if bytes && normalized { entry["normalized"] = true }
    if let minimum, let maximum {
      entry["min"] = minimum
      entry["max"] = maximum
    }
    accessors.append(entry)
    return accessors.count - 1
  }
  // A guest can extract a GLB image. Keep only photo pixels covering published faces.
  private static func surfaceTexture(_ url: URL, vertices: [ScanVertex]) throws -> Data {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let context = CGContext(
        data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw ScanFailure.photo }
    let w = CGFloat(image.width)
    let h = CGFloat(image.height)
    let rect = CGRect(x: 0, y: 0, width: w, height: h)
    context.setFillColor(gray: 0.55, alpha: 1)
    context.fill(rect)
    func point(_ uv: SIMD2<Float>) -> CGPoint {
      CGPoint(x: CGFloat(uv.x) * w, y: (1 - CGFloat(uv.y)) * h)
    }
    context.beginPath()
    for n in stride(from: 0, to: vertices.count, by: 3) {
      let a = point(vertices[n].uv)
      let b = point(vertices[n + 1].uv)
      let c = point(vertices[n + 2].uv)
      let positive = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) >= 0
      context.move(to: a)
      context.addLine(to: positive ? b : c)
      context.addLine(to: positive ? c : b)
      context.closePath()
    }
    context.clip(using: .winding)
    context.draw(image, in: rect)
    let data = NSMutableData()
    guard let pixels = context.makeImage(),
      let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
    else { throw ScanFailure.photo }
    CGImageDestinationAddImage(
      dest, pixels, [kCGImageDestinationLossyCompressionQuality: 0.88] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw ScanFailure.photo }
    return data as Data
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
          groups[chosen, default: []].append(
            ScanVertex(p: p, color: color, classification: f.classification, uv: uvs[i]))
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
      var classes = Data()
      xyz.reserveCapacity(verts.count * 12)
      var low = verts[0].p
      var high = low
      for v in verts {
        for i in 0..<3 {
          xyz.appendLE(v.p[i].bitPattern)
          rgb.append(v.color[i])
        }
        rgb.append(255)
        if result.triangles > 0 { classes.appendLE(UInt32(v.classification)) }
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
      if result.triangles > 0 {
        attrs["_AR_CLASSIFICATION"] = attribute(
          classes, type: "VEC4", count: verts.count, bytes: true, normalized: false)
      }
      var pbr: [String: Any] = ["metallicFactor": 0, "roughnessFactor": 1]
      if n >= 0 {
        let iv = view(try Self.surfaceTexture(photos[n].url, vertices: verts))
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
      "scenes": [["nodes": [0]]], "nodes": [["mesh": 0]],
      "meshes": [["primitives": primitives, "extras": ["classificationNames": Self.labels]]],
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
  case empty, photo, badPair
  var errorDescription: String? {
    switch self {
    case .empty:
      return "No geometry was recorded. Keep a textured feature in view until tracking is normal."
    case .photo: return "A camera texture could not be prepared."
    case .badPair: return "Scan or paste the HTTPS organizer link from the Mac pairing page."

    }
  }
}
