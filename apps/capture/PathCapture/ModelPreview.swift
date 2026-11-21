import SceneKit
import SwiftUI

// Read the subset of glTF emitted by NativeGLB. Models stay on device during review.
enum ModelPreview {
  static func scene(_ url: URL) throws -> SCNScene {
    let file = try Data(contentsOf: url, options: .mappedIfSafe)
    guard file.count >= 28 else { throw ScanFailure.empty }
    let jsize = Int(
      file.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 12, as: UInt32.self).littleEndian })
    guard jsize <= file.count - 28 else { throw ScanFailure.empty }
    let bin = 28 + jsize
    guard
      let doc = try JSONSerialization.jsonObject(with: file.subdata(in: 20..<(20 + jsize)))
        as? [String: Any], let views = doc["bufferViews"] as? [[String: Any]],
      let access = doc["accessors"] as? [[String: Any]],
      let meshes = doc["meshes"] as? [[String: Any]],
      let prim = meshes.first?["primitives"] as? [[String: Any]]
    else { throw ScanFailure.empty }
    func bytes(_ idx: Int) throws -> Data {
      guard views.indices.contains(idx), let length = views[idx]["byteLength"] as? Int else {
        throw ScanFailure.empty
      }
      let offset = views[idx]["byteOffset"] as? Int ?? 0
      guard offset >= 0, length >= 0, offset <= file.count - bin,
        length <= file.count - bin - offset
      else { throw ScanFailure.empty }
      return file.subdata(in: (bin + offset)..<(bin + offset + length))
    }
    let scene = SCNScene()
    let model = SCNNode()
    scene.rootNode.addChildNode(model)
    for p in prim {
      guard let attr = p["attributes"] as? [String: Int], let pi = attr["POSITION"],
        access.indices.contains(pi), let count = access[pi]["count"] as? Int
      else { throw ScanFailure.empty }
      var sources: [SCNGeometrySource] = []
      for (name, semantic, components, width) in [
        ("POSITION", SCNGeometrySource.Semantic.vertex, 3, 4), ("COLOR_0", .color, 4, 1),
        ("TEXCOORD_0", .texcoord, 2, 4),
      ] {
        if let a = attr[name], access.indices.contains(a), let v = access[a]["bufferView"] as? Int {
          var data = try bytes(v)
          if name == "TEXCOORD_0" {
            data.withUnsafeMutableBytes { raw in
              let values = raw.bindMemory(to: Float.self)
              for n in stride(from: 1, to: values.count, by: 2) { values[n] = 1 - values[n] }
            }
          }
          sources.append(
            SCNGeometrySource(
              data: data, semantic: semantic, vectorCount: count, usesFloatComponents: width == 4,
              componentsPerVector: components, bytesPerComponent: width, dataOffset: 0,
              dataStride: width * components))
        }
      }
      let triangles = (p["mode"] as? Int) == 4
      let element = SCNGeometryElement(
        data: nil, primitiveType: triangles ? .triangles : .point,
        primitiveCount: triangles ? count / 3 : count, bytesPerIndex: 0)
      if !triangles {
        element.pointSize = 0.025
        element.minimumPointScreenSpaceRadius = 1
        element.maximumPointScreenSpaceRadius = 4
      }
      let geometry = SCNGeometry(sources: sources, elements: [element])
      let m = SCNMaterial()
      m.isDoubleSided = true
      m.lightingModel = .constant
      if let mats = doc["materials"] as? [[String: Any]], let mi = p["material"] as? Int,
        mats.indices.contains(mi), let pbr = mats[mi]["pbrMetallicRoughness"] as? [String: Any],
        let tex = pbr["baseColorTexture"] as? [String: Int], let ti = tex["index"],
        let textures = doc["textures"] as? [[String: Int]], textures.indices.contains(ti),
        let ii = textures[ti]["source"], let images = doc["images"] as? [[String: Any]],
        images.indices.contains(ii), let vi = images[ii]["bufferView"] as? Int
      {
        m.diffuse.contents = UIImage(data: try bytes(vi))
      }
      geometry.materials = [m]
      model.addChildNode(SCNNode(geometry: geometry))
    }
    let bounds = model.boundingBox
    let lo = SIMD3<Float>(bounds.min)
    let hi = SIMD3<Float>(bounds.max)
    let center = (lo + hi) / 2
    let span = max(0.3, simd_distance(lo, hi))
    let cam = SCNNode()
    cam.camera = SCNCamera()
    cam.camera?.automaticallyAdjustsZRange = true
    cam.simdPosition = center + SIMD3(0.65, 0.5, 1) * span
    cam.look(at: SCNVector3(center))
    scene.rootNode.addChildNode(cam)
    scene.background.contents = UIColor(red: 0.055, green: 0.087, blue: 0.073, alpha: 1)
    return scene
  }
}
struct ScanPreview: View {
  let url: URL
  @State private var scene: SCNScene?
  @State private var failed = false
  var body: some View {
    Group {
      if let scene {
        SceneView(scene: scene, options: [.allowsCameraControl, .autoenablesDefaultLighting])
      } else if failed {
        ContentUnavailableView("Preview unavailable", systemImage: "viewfinder")
      } else {
        ProgressView("Opening scan")
      }
    }.task(id: url) {
      do { scene = try await Task.detached { try ModelPreview.scene(url) }.value } catch {
        failed = true
      }
    }
  }
}
