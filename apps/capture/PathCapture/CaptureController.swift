import ARKit
import AVFoundation
import SwiftUI

final class CaptureController: NSObject, ObservableObject, ARSessionDelegate {
  enum Phase { case ready, requestingCamera, recording, saving, finished }
  let session = ARSession()
  let supportsDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
  let supportsMesh = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
  var supported: Bool { ARWorldTrackingConfiguration.isSupported }
  var mode: String {
    supportsMesh ? "LiDAR surface" : (supportsDepth ? "LiDAR points" : "Tracked camera")
  }
  @Published private(set) var phase: Phase = .ready
  @Published private(set) var instruction =
    "Keep a doorway or another fixed feature in view through the turn."
  @Published private(set) var pointCount = 0
  @Published private(set) var faceCount = 0
  @Published private(set) var motionCount = 0
  @Published private(set) var duration = 0.0
  @Published private(set) var tracking = "Waiting"
  @Published private(set) var library = ScanRecord.all()
  @Published var selected: ScanRecord?
  private var cloud = PointCloud(), mesh: [UUID: ARMeshAnchor] = [:]
  private var take: TakeRecorder?
  private var lastSampleTime = -Double.infinity
  override init() {
    super.init()
    session.delegateQueue = .main
    session.delegate = self
  }
  func reload() { library = ScanRecord.all() }
  @MainActor func start() async {
    guard supported, phase == .ready || phase == .finished else { return }
    phase = .requestingCamera
    guard await AVCaptureDevice.requestAccess(for: .video) else {
      phase = .ready
      instruction = "Allow camera access in Settings to start a scan."
      return
    }
    guard phase == .requestingCamera else { return }
    do { take = try TakeRecorder() } catch {
      phase = .ready
      instruction = "Could not create a local scan. Check the phone’s storage."
      return
    }
    selected = nil
    cloud = PointCloud()
    mesh.removeAll()
    pointCount = 0
    faceCount = 0
    motionCount = 0
    duration = 0
    lastSampleTime = -.infinity
    tracking = "Starting"
    let c = ARWorldTrackingConfiguration()
    c.worldAlignment = .gravity
    c.planeDetection = [.horizontal, .vertical]
    if supportsDepth { c.frameSemantics.insert(.sceneDepth) }
    if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
      c.sceneReconstruction = .meshWithClassification
    } else if supportsMesh {
      c.sceneReconstruction = .mesh
    }
    phase = .recording
    instruction = "Hold still until tracking is ready."
    session.run(c, options: [.resetTracking, .removeExistingAnchors])
  }
  func session(_ session: ARSession, didAdd anchors: [ARAnchor]) { update(anchors) }
  func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) { update(anchors) }
  func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
    for a in anchors { mesh.removeValue(forKey: a.identifier) }
  }
  private func update(_ anchors: [ARAnchor]) {
    guard phase == .recording else { return }
    for case let a as ARMeshAnchor in anchors { mesh[a.identifier] = a }
  }
  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard phase == .recording, let take else { return }
    let quality: String
    let guide: String
    switch frame.camera.trackingState {
    case .normal:
      quality = "normal"
      guide = "Keep the same wall or landmark in view as you turn."
    case .limited(let reason):
      quality = "limited"
      switch reason {
      case .excessiveMotion: guide = "Steady the phone until the camera catches up."
      case .insufficientFeatures: guide = "Point toward a doorway, floor pattern or sign."
      case .relocalizing: guide = "Return to the last area you scanned."
      default: guide = "Hold still while tracking starts."
      }
    case .notAvailable:
      quality = "unavailable"
      guide = "Waiting for camera tracking."
    }
    take.frame(frame, tracking: quality, usePhotos: supportsMesh)
    guard frame.timestamp - lastSampleTime >= 0.20 else { return }
    lastSampleTime = frame.timestamp
    if quality == "normal" {
      if let d = frame.sceneDepth, let conf = d.confidenceMap {
        sample(frame, depth: d.depthMap, confidence: conf)
      } else if let features = frame.rawFeaturePoints {
        sampleFeatures(frame, points: features.points)
      }
    }
    pointCount = cloud.count
    faceCount = mesh.values.reduce(0) { $0 + $1.geometry.faces.count }
    motionCount = take.motionCount
    duration = take.seconds
    tracking = quality.capitalized
    instruction = guide
    if duration >= 85 || faceCount >= 220_000 || cloud.isFull { stop() }
  }
  func stop(interrupted: Bool = false) {
    if phase == .requestingCamera {
      phase = .ready
      return
    }
    guard phase == .recording, let take else { return }
    phase = .saving
    session.pause()
    self.take = nil
    let anchors = Array(mesh.values)
    let cloud = self.cloud
    let mode = self.mode
    mesh.removeAll()
    instruction = "Saving geometry, camera poses and motion on this phone."
    let background = UIApplication.shared.beginBackgroundTask(
      withName: "Save hallway scan", expirationHandler: nil)
    Task { @MainActor in
      defer { if background != .invalid { UIApplication.shared.endBackgroundTask(background) } }
      do {
        let media = try await take.endMedia()
        let record = try await Task.detached(priority: .userInitiated) { () throws -> ScanRecord in
          let chunks = anchors.compactMap(Self.geometry)
          var glb = NativeGLB()
          var meshInfo = MeshExport()
          if !chunks.isEmpty || cloud.count > 0 {
            meshInfo = try glb.write(
              chunks: chunks, cloud: cloud, photos: take.photos,
              to: take.directory.appendingPathComponent("scene.glb"))
          }
          guard meshInfo.triangles > 0 || cloud.count > 0 || media.hasVideo else {
            throw ScanFailure.empty
          }
          if cloud.count > 0 {
            try cloud.binaryPLY().write(
              to: take.directory.appendingPathComponent("points.ply"), options: .atomic)
          }
          let record = ScanRecord(
            id: take.id, created: take.created, duration: take.seconds, mode: mode,
            pointCount: cloud.count, triangles: meshInfo.triangles,
            photoFaces: meshInfo.texturedTriangles, poseCount: take.poseCount,
            gyroCount: media.motion, classes: meshInfo.classes, hasVideo: media.hasVideo,
            partial: interrupted)
          try record.persist()
          return record
        }.value
        reload()
        selected = record
        instruction = "Scan saved on this phone."
      } catch { instruction = "Couldn’t finish this scan. \(error.localizedDescription)" }
      self.cloud = PointCloud()
      phase = .finished
    }
  }
  func sessionWasInterrupted(_ session: ARSession) { stop(interrupted: true) }
  func session(_ session: ARSession, didFailWithError error: Error) { stop(interrupted: true) }
  private static func geometry(_ a: ARMeshAnchor) -> SurfaceChunk? {
    let g = a.geometry
    let v = g.vertices
    let faces = g.faces
    guard v.format == .float3, faces.indexCountPerPrimitive == 3,
      [2, 4].contains(faces.bytesPerIndex)
    else { return nil }
    let vptr = v.buffer.contents()
    var points = [SIMD3<Float>]()
    points.reserveCapacity(v.count)
    for i in 0..<v.count {
      let p = vptr.advanced(by: v.offset + i * v.stride).assumingMemoryBound(to: Float.self)
      let w = a.transform * SIMD4(p[0], p[1], p[2], 1)
      points.append(SIMD3(w.x, w.y, w.z))
    }
    let iptr = faces.buffer.contents()
    var triangles = [SurfaceFace]()
    triangles.reserveCapacity(faces.count)
    for i in 0..<faces.count {
      func index(_ axis: Int) -> Int32 {
        let n = 3 * i + axis
        return faces.bytesPerIndex == 2
          ? Int32(iptr.assumingMemoryBound(to: UInt16.self)[n])
          : Int32(bitPattern: iptr.assumingMemoryBound(to: UInt32.self)[n])
      }
      let semantic =
        g.classification.map {
          $0.buffer.contents().load(fromByteOffset: $0.offset + i * $0.stride, as: UInt8.self)
        } ?? 0
      triangles.append(
        SurfaceFace(indices: SIMD3(index(0), index(1), index(2)), classification: semantic))
    }
    return SurfaceChunk(vertices: points, faces: triangles)
  }
  private func sampleFeatures(_ f: ARFrame, points: [SIMD3<Float>]) {
    let image = f.capturedImage
    guard CVPixelBufferGetPlaneCount(image) == 2,
      CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess
    else { return }
    defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
    guard let y = CVPixelBufferGetBaseAddressOfPlane(image, 0)?.assumingMemoryBound(to: UInt8.self),
      let c = CVPixelBufferGetBaseAddressOfPlane(image, 1)?.assumingMemoryBound(to: UInt8.self)
    else { return }
    let w = CVPixelBufferGetWidthOfPlane(image, 0)
    let h = CVPixelBufferGetHeightOfPlane(image, 0)
    let ys = CVPixelBufferGetBytesPerRowOfPlane(image, 0)
    let cs = CVPixelBufferGetBytesPerRowOfPlane(image, 1)
    let inv = f.camera.transform.inverse
    let k = f.camera.intrinsics
    for p in points {
      let cp = inv * SIMD4(p, 1)
      let z = -cp.z
      guard z > 0.1, z < 12 else { continue }
      let px = k[0].x * cp.x / z + k[2].x
      let py = k[2].y - k[1].y * cp.y / z
      guard px >= 0, py >= 0, px < Float(w), py < Float(h) else { continue }
      let u = Int(px)
      let v = Int(py)
      let ci = (v / 2) * cs + (u / 2) * 2
      cloud.add(
        p,
        color: Self.rgb(
          y[v * ys + u], c[ci], c[ci + 1],
          fullRange: CVPixelBufferGetPixelFormatType(image)
            == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange))
    }
  }
  private func sample(_ frame: ARFrame, depth: CVPixelBuffer, confidence: CVPixelBuffer) {
    let image = frame.capturedImage
    let imageFormat = CVPixelBufferGetPixelFormatType(image)
    let fullRange = imageFormat == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    guard fullRange || imageFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      CVPixelBufferLockBaseAddress(depth, .readOnly) == kCVReturnSuccess
    else { return }
    defer { CVPixelBufferUnlockBaseAddress(depth, .readOnly) }
    guard CVPixelBufferLockBaseAddress(confidence, .readOnly) == kCVReturnSuccess else { return }
    defer { CVPixelBufferUnlockBaseAddress(confidence, .readOnly) }
    guard CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess else { return }
    defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }

    guard let depthBase = CVPixelBufferGetBaseAddress(depth)?.assumingMemoryBound(to: Float32.self),
      let confidenceBase = CVPixelBufferGetBaseAddress(confidence)?.assumingMemoryBound(
        to: UInt8.self),
      let luma = CVPixelBufferGetBaseAddressOfPlane(image, 0)?.assumingMemoryBound(to: UInt8.self),
      let chroma = CVPixelBufferGetBaseAddressOfPlane(image, 1)?.assumingMemoryBound(to: UInt8.self)
    else { return }

    let width = CVPixelBufferGetWidth(depth)
    let height = CVPixelBufferGetHeight(depth)
    guard CVPixelBufferGetWidth(confidence) == width,
      CVPixelBufferGetHeight(confidence) == height,
      CVPixelBufferGetPixelFormatType(depth) == kCVPixelFormatType_DepthFloat32
    else { return }

    let depthStride = CVPixelBufferGetBytesPerRow(depth) / MemoryLayout<Float32>.stride
    let confidenceStride = CVPixelBufferGetBytesPerRow(confidence)
    let imageWidth = CVPixelBufferGetWidthOfPlane(image, 0)
    let imageHeight = CVPixelBufferGetHeightOfPlane(image, 0)
    let chromaWidth = CVPixelBufferGetWidthOfPlane(image, 1)
    let chromaHeight = CVPixelBufferGetHeightOfPlane(image, 1)
    let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(image, 0)
    let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(image, 1)
    let intrinsics = frame.camera.intrinsics
    let cameraToWorld = frame.camera.transform
    let scaleX = Float(frame.camera.imageResolution.width) / Float(width)
    let scaleY = Float(frame.camera.imageResolution.height) / Float(height)
    let minimumConfidence = UInt8(ARConfidenceLevel.medium.rawValue)

    for y in stride(from: 0, to: height, by: 3) {
      for x in stride(from: 0, to: width, by: 3) {
        if cloud.isFull { return }
        let meters = depthBase[y * depthStride + x]
        guard meters >= 0.25, meters <= 4,
          confidenceBase[y * confidenceStride + x] >= minimumConfidence
        else { continue }

        let position = PointCloud.unproject(
          x: Float(x) * scaleX, y: Float(y) * scaleY, depth: meters,
          intrinsics: intrinsics, cameraToWorld: cameraToWorld
        )
        let imageX = x * imageWidth / width
        let imageY = y * imageHeight / height
        let colorIndex = (y * chromaHeight / height) * chromaStride + (x * chromaWidth / width) * 2
        let color = Self.rgb(
          luma[imageY * lumaStride + imageX], chroma[colorIndex], chroma[colorIndex + 1],
          fullRange: fullRange
        )
        cloud.add(position, color: color)
      }
    }
  }

  private static func rgb(_ luma: UInt8, _ cb: UInt8, _ cr: UInt8, fullRange: Bool) -> SIMD3<UInt8>
  {
    let y = fullRange ? Float(luma) : (Float(luma) - 16) * 255 / 219
    let chromaScale: Float = fullRange ? 1 : 255 / 224
    let u = (Float(cb) - 128) * chromaScale
    let v = (Float(cr) - 128) * chromaScale
    func channel(_ value: Float) -> UInt8 {
      UInt8(clamping: Int(value.rounded()))
    }
    return SIMD3(
      channel(y + 1.402 * v), channel(y - 0.344136 * u - 0.714136 * v), channel(y + 1.772 * u))
  }
}
