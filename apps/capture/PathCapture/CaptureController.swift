import ARKit
import AVFoundation
import SwiftUI

final class CaptureController: NSObject, ScanSource, ARSessionDelegate {
  let session = ARSession()
  let supportsDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
  let supportsMesh = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
  var supported: Bool { ARWorldTrackingConfiguration.isSupported }
  var mode: String {
    supportsMesh ? "LiDAR surface" : (supportsDepth ? "LiDAR points" : "Tracked camera")
  }
  @Published private(set) var phase: ScanPhase = .ready
  @Published private(set) var instruction =
    "Keep a doorway or another fixed feature in view through the turn."
  @Published private(set) var pointCount = 0
  @Published private(set) var faceCount = 0
  @Published private(set) var motionCount = 0
  @Published private(set) var duration = 0.0
  @Published private(set) var tracking: TrackingQuality = .waiting
  @Published private(set) var library = ScanRecord.all()
  @Published var selected: ScanRecord?
  private var cloud = PointCloud(), mesh: [UUID: ARMeshAnchor] = [:]
  @Published private(set) var liveMap = WalkMap()
  @Published private(set) var savedSections = 0
  @Published private(set) var sectionNumber = 1
  private var completedLayers = [WalkLayer]()
  private var activeLayer = WalkLayer(WalkMap())
  var mapLayers: [WalkLayer] { completedLayers + [activeLayer] }
  private var sectionMap = WalkMap()
  private var walkID = UUID()
  private var walkStart: Double?
  private var lastNewTile = -Double.infinity
  private var lastMapPublish = -Double.infinity
  @Published private(set) var rescanSide: RescanSide?
  private var sideGuidance = SideGuidance()
  private var depthHits = 0
  private var lastStorageCheck = -Double.infinity
  private var idleTimerBeforeWalk = false
  private var saving = [Int: Task<ScanRecord, Error>]()
  private var retiredMesh = [UUID: SurfaceChunk]()
  private var retiredFaces = 0
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
    walkID = UUID()
    sideGuidance = SideGuidance()
    rescanSide = nil
    walkStart = nil
    sectionNumber = 1
    savedSections = 0
    saving.removeAll()
    completedLayers = []
    activeLayer = WalkLayer(WalkMap())
    sectionMap = WalkMap()
    liveMap = WalkMap()
    lastStorageCheck = -.infinity
    lastNewTile = -.infinity
    lastMapPublish = -.infinity
    idleTimerBeforeWalk = UIApplication.shared.isIdleTimerDisabled
    UIApplication.shared.isIdleTimerDisabled = true
    cloud = PointCloud()
    mesh.removeAll()
    retiredMesh.removeAll()
    retiredFaces = 0
    pointCount = 0
    faceCount = 0
    motionCount = 0
    duration = 0
    lastSampleTime = -.infinity
    tracking = .starting
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
    guard phase == .recording else { return }
    for a in anchors {
      if let last = mesh.removeValue(forKey: a.identifier), let chunk = Self.geometry(last) {
        retiredMesh[a.identifier] = chunk
        retiredFaces += chunk.faces.count
      }
    }
  }
  private func update(_ anchors: [ARAnchor]) {
    guard phase == .recording else { return }
    for case let a as ARMeshAnchor in anchors {
      if let previous = retiredMesh.removeValue(forKey: a.identifier) { retiredFaces -= previous.faces.count }
      mesh[a.identifier] = a
    }
  }
  func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard phase == .recording, let take else { return }
    let quality: TrackingQuality
    let guide: String
    switch frame.camera.trackingState {
    case .normal:
      quality = .normal
      guide = "Keep the same wall or landmark in view as you turn."
    case .limited(let reason):
      quality = .limited
      switch reason {
      case .excessiveMotion: guide = "Steady the phone until the camera catches up."
      case .insufficientFeatures: guide = "Point toward a doorway, floor pattern or sign."
      case .relocalizing: guide = "Return to the last area you scanned."
      default: guide = "Hold still while tracking starts."
      }
    case .notAvailable:
      quality = .unavailable
      guide = "Waiting for camera tracking."
    }
    if walkStart == nil { walkStart = frame.timestamp }
    take.frame(frame, tracking: quality.rawValue, usePhotos: supportsMesh)
    // A short tracking loss between display updates still breaks the route line.
    if quality != .normal {
      sectionMap.tracked = false
      sideGuidance = SideGuidance()
      if rescanSide != nil { rescanSide = nil }
    }
    guard frame.timestamp - lastSampleTime >= 0.20 else { return }
    lastSampleTime = frame.timestamp
    let camera = frame.camera.transform
    sectionMap.locate(SIMD2(camera.columns.3.x, camera.columns.3.z),
      forward: SIMD2(-camera.columns.2.x, -camera.columns.2.z), at: frame.timestamp, normal: quality == .normal)
    let before = sectionMap.tiles.count
    depthHits = 0
    var sideFrame = SideObservation()
    if quality == .normal {
      if let d = frame.sceneDepth, let conf = d.confidenceMap {
        sideFrame = sample(frame, depth: d.depthMap, confidence: conf)
      } else if let features = frame.rawFeaturePoints {
        sampleFeatures(frame, points: features.points)
      }
    }
    if quality == .normal && supportsDepth {
      sideGuidance.update(position: SIMD3(camera.columns.3.x, camera.columns.3.y, camera.columns.3.z),
                          at: frame.timestamp, frame: sideFrame)
      if rescanSide != sideGuidance.cue { rescanSide = sideGuidance.cue }
    }
    pointCount = cloud.count
    faceCount = mesh.values.reduce(retiredFaces) { $0 + $1.geometry.faces.count }
    motionCount = take.motionCount
    duration = frame.timestamp - (walkStart ?? frame.timestamp)
    tracking = quality
    instruction = guide
    if sectionMap.tiles.count > before { lastNewTile = frame.timestamp }
    if quality == .normal, supportsDepth, depthHits < 4 {
      instruction = "Few depth returns. Aim at a closer wall or tilt toward the floor."
    } else if quality == .normal, frame.timestamp - lastNewTile > 3, !sectionMap.tiles.isEmpty {
      instruction = "This area is already on the map. Sweep toward a dark edge to add coverage."
    }
    if frame.timestamp - lastMapPublish >= 0.4 {
      activeLayer = WalkLayer(sectionMap)
      liveMap = sectionMap
      lastMapPublish = frame.timestamp
    }
    if frame.timestamp - lastStorageCheck > 5 {
      lastStorageCheck = frame.timestamp
      if let free = try? take.directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage,
        free < 200 * 1024 * 1024 {
        stop(reason: "The phone is low on storage.")
        return
      }
    }
    if SectionBudget.shouldSave(seconds: take.seconds, points: pointCount, faces: faceCount) {
      if saving.count < 2 {
        rotateSection(prioritizeDepth: !saving.isEmpty)
      } else if take.seconds >= 90 {
        stop(reason: "Two sections are still writing to storage. Earlier sections remain on this phone.")
      } else {
        instruction = quality == .normal ? "Still recording while earlier sections save." : guide
      }
    }
  }
  private func rotateSection(prioritizeDepth: Bool) {
    guard let previous = take else { return }
    let next: TakeRecorder
    do { next = try TakeRecorder() } catch {
      stop(reason: "A new section could not be created. Check free storage.")
      return
    }
    let section = sectionNumber
    let job = saveSection(previous, reason: nil, prioritizeDepth: prioritizeDepth)
    saving[section] = job
    let id = walkID
    completedLayers.append(WalkLayer(sectionMap))
    sectionMap = sectionMap.nextSection()
    activeLayer = WalkLayer(sectionMap)
    liveMap = sectionMap
    take = next
    sectionNumber += 1
    Task { @MainActor in
      let result = await job.result
      guard walkID == id else { return }
      saving.removeValue(forKey: section)
      switch result {
      case .success:
        savedSections += 1
      case .failure(let error):
        if phase == .recording { stop(reason: "Section \(section) could not finish saving: \(error.localizedDescription)") }
      }
    }
  }

  func stop(reason: String? = nil) {
    if phase == .requestingCamera { phase = .ready; return }
    guard phase == .recording, let last = take else { return }
    rescanSide = nil
    phase = .saving
    session.pause()
    UIApplication.shared.isIdleTimerDisabled = idleTimerBeforeWalk
    take = nil
    let prior = Array(saving.values)
    let final: Task<ScanRecord, Error>?
    if sectionNumber > 1 && last.poseCount == 0 {
      // Finishing exactly at rollover should not manufacture another section.
      last.stopMotion()
      final = nil
    } else {
      final = saveSection(last, reason: reason, after: prior)
    }
    let id = walkID
    instruction = reason ?? "Saving the last section of your walk."
    let background = UIApplication.shared.beginBackgroundTask(withName: "Save hallway walk", expirationHandler: nil)
    Task { @MainActor in
      defer { if background != .invalid { UIApplication.shared.endBackgroundTask(background) } }
      let result = await final?.result
      var failures = [String]()
      for job in prior {
        if case .failure(let error) = await job.result { failures.append(error.localizedDescription) }
      }
      if case .failure(let error) = result { failures.append(error.localizedDescription) }
      reload()
      let saved = library.filter { $0.walkID == id }
      selected = saved.max { ($0.sectionNumber ?? 0) < ($1.sectionNumber ?? 0) }
      let detail = ([reason].compactMap { $0 } + failures).joined(separator: " ")
      instruction = (saved.isEmpty ? "No section was saved." : "Saved \(saved.count) section(s) on this phone.") + (detail.isEmpty ? "" : " " + detail)
      if !detail.isEmpty, var latest = selected, latest.walkEndReason != detail {
        latest.walkEndReason = detail
        do { try latest.persist(); reload(); selected = latest }
        catch { instruction += " Could not save the stop reason." }
      }
      phase = .finished
    }
  }

  private func saveSection(_ take: TakeRecorder, reason: String?, prioritizeDepth: Bool = false, after previous: [Task<ScanRecord, Error>] = []) -> Task<ScanRecord, Error> {
    // Copy Metal-backed geometry before ARKit can update it during the next section.
    let chunks = prioritizeDepth ? [] : mesh.values.compactMap(Self.geometry) + retiredMesh.values
    retiredMesh.removeAll()
    retiredFaces = 0
    let cloud = self.cloud
    let map = sectionMap
    let walkID = self.walkID, number = sectionNumber, mode = self.mode
    mesh.removeAll()
    self.cloud = PointCloud()
    take.stopMotion()
    let dense = chunks.reduce(0) { $0 + $1.faces.count } > 90_000
    return Task {
      let media = try await take.endMedia()
      return try await Task.detached(priority: .utility) {
        var record = ScanRecord(
          id: take.id, created: take.created, duration: take.seconds, mode: mode,
          pointCount: 0, triangles: 0, photoFaces: 0, poseCount: take.poseCount,
          gyroCount: media.motion, classes: [:], hasVideo: media.hasVideo, partial: true)
        record.walkID = walkID
        record.sectionNumber = number
        record.walkEndReason = reason
        record.depthPriority = prioritizeDepth
        record.deviceOSVersion = ProcessInfo.processInfo.operatingSystemVersionString
        var system = utsname()
        if uname(&system) == 0 {
          record.deviceModel = withUnsafeBytes(of: &system.machine) {
            String(decoding: $0.prefix(while: { $0 != 0 }), as: UTF8.self)
          }
        }
        try map.write(to: take.directory)
        if media.hasVideo || take.poseCount > 0 { try record.persist() }
        if cloud.count > 0 {
          try cloud.binaryPLY().write(to: take.directory.appendingPathComponent("points.ply"), options: .atomic)
          record.pointCount = cloud.count
          try record.persist()
        }
        // Footage, map and points are discoverable even if iOS suspends this export.
        for job in previous { _ = await job.result }
        if !chunks.isEmpty || cloud.count > 0 {
          var glb = NativeGLB()
          let surfaces = dense ? chunks.map { $0.clustered(cell: 0.04) } : chunks
          let info = try glb.write(chunks: surfaces, cloud: cloud, photos: take.photos,
            to: take.directory.appendingPathComponent("scene.glb"))
          record.triangles = info.triangles
          record.photoFaces = info.texturedTriangles
          record.classes = info.classes
        }
        guard record.triangles > 0 || record.pointCount > 0 || record.hasVideo else { throw ScanFailure.empty }
        record.partial = reason != nil
        try record.persist()
        return record
      }.value
    }
  }

  func sessionWasInterrupted(_ session: ARSession) { stop(reason: "iOS interrupted the AR session.") }
  func session(_ session: ARSession, didFailWithError error: Error) { stop(reason: error.localizedDescription) }
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
      sectionMap.observe(p, cameraHeight: f.camera.transform.columns.3.y)
      cloud.add(
        p,
        color: Self.rgb(
          y[v * ys + u], c[ci], c[ci + 1],
          fullRange: CVPixelBufferGetPixelFormatType(image)
            == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange))
    }
  }
  private func sample(_ frame: ARFrame, depth: CVPixelBuffer, confidence: CVPixelBuffer) -> SideObservation {
    let image = frame.capturedImage
    let imageFormat = CVPixelBufferGetPixelFormatType(image)
    let fullRange = imageFormat == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
    guard fullRange || imageFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      CVPixelBufferLockBaseAddress(depth, .readOnly) == kCVReturnSuccess
    else { return SideObservation() }
    defer { CVPixelBufferUnlockBaseAddress(depth, .readOnly) }
    guard CVPixelBufferLockBaseAddress(confidence, .readOnly) == kCVReturnSuccess else { return SideObservation() }
    defer { CVPixelBufferUnlockBaseAddress(confidence, .readOnly) }
    guard CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess else { return SideObservation() }
    defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }

    guard let depthBase = CVPixelBufferGetBaseAddress(depth)?.assumingMemoryBound(to: Float32.self),
      let confidenceBase = CVPixelBufferGetBaseAddress(confidence)?.assumingMemoryBound(
        to: UInt8.self),
      let luma = CVPixelBufferGetBaseAddressOfPlane(image, 0)?.assumingMemoryBound(to: UInt8.self),
      let chroma = CVPixelBufferGetBaseAddressOfPlane(image, 1)?.assumingMemoryBound(to: UInt8.self)
    else { return SideObservation() }

    let width = CVPixelBufferGetWidth(depth)
    let height = CVPixelBufferGetHeight(depth)
    guard CVPixelBufferGetWidth(confidence) == width,
      CVPixelBufferGetHeight(confidence) == height,
      CVPixelBufferGetPixelFormatType(depth) == kCVPixelFormatType_DepthFloat32
    else { return SideObservation() }

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
        let coveragePixel = x.isMultiple(of: 12) && y.isMultiple(of: 12)
        if cloud.isFull && !coveragePixel { continue }
        let meters = depthBase[y * depthStride + x]
        guard meters >= 0.25, meters <= 4,
          confidenceBase[y * confidenceStride + x] >= minimumConfidence
        else { continue }

        let position = PointCloud.unproject(
          x: Float(x) * scaleX, y: Float(y) * scaleY, depth: meters,
          intrinsics: intrinsics, cameraToWorld: cameraToWorld
        )
        if coveragePixel {
          depthHits += 1
          sectionMap.observe(position, cameraHeight: cameraToWorld.columns.3.y)
        }
        if cloud.isFull { continue }
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
    return SideObservation.sample(width: width, height: height,
      focal: SIMD2(intrinsics.columns.0.x / scaleX, intrinsics.columns.1.y / scaleY),
      center: SIMD2(intrinsics.columns.2.x / scaleX, intrinsics.columns.2.y / scaleY),
      camera: cameraToWorld) { x, y in
        let level = confidenceBase[y * confidenceStride + x]
        return (minimumConfidence...2).contains(level) ? depthBase[y * depthStride + x] : nil
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
