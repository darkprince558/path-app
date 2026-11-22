import ARKit
import AVFoundation
import CoreImage
import CoreMotion
import Foundation

struct MotionAxis: Codable { let x, y, z: Double }
struct MotionRotation: Codable { let alpha, beta, gamma: Double }
struct MotionReading: Codable {
  let tMs: Double
  let acceleration, accelerationIncludingGravity: MotionAxis
  let rotationRate: MotionRotation
}
struct MotionFile: Encodable {
  let version = 1
  let timebase = "recording-start-ms"
  let permission: String
  let durationMs: Double
  let samples: [MotionReading]
}
struct CameraSample: Codable {
  let t: Double
  let cameraToWorld: [Float]
  let intrinsics: [Float]
  let imageWidth, imageHeight: Int
  let tracking: String
}
struct CalibratedFrame: Encodable {
  let camera: CameraSample
  let jpeg: String
  let depthMetersFloat32LE, confidenceUInt8: String?
  let depthWidth, depthHeight: Int?
  /// Estimated motion smear in pixels of the saved photo, so the Mac can skip soft frames.
  var blurPixels: Double? = nil
}
final class TakeRecorder {
  let id = UUID()
  let created = Date()
  let directory: URL
  private let motion = CMMotionManager()
  private let motionQueue = OperationQueue()
  private var readings: [(Double, MotionAxis, MotionAxis, MotionRotation)] = []
  private let lock = NSLock()
  private var poses: [CameraSample] = []
  private var keyframes: [CalibratedFrame] = []
  private let context = CIContext(options: [.cacheIntermediates: false])
  private let photoInterval = 0.8
  private var nextPhotoID = 0
  private var lastPhotoPose: simd_float4x4?
  private(set) var photos: [ScanPhoto] = []
  private(set) var origin: Double?
  private var lastFrame = 0.0, lastVideo = 0.0, lastPhoto = 0.0
  private var video: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var pixels: AVAssetWriterInputPixelBufferAdaptor?
  private var attemptedWriter = false
  private var encodedFrames = 0
  private var gate = KeyframeGate()
  private var previousPose: (t: Double, transform: simd_float4x4)?
  private var gyroTurnRate = 0.0
  /// Recent motion smear, in pixels of a saved photo, smoothed over a few frames.
  private(set) var smear = 0.0
  /// The walker is moving or turning too fast for sharp photos at the current exposure.
  /// It switches on well above the limit and off near it, so the message does not flicker.
  private(set) var smearing = false
  init() throws {
    directory = ScanRecord.library.appendingPathComponent(id.uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    motionQueue.maxConcurrentOperationCount = 1
    motion.deviceMotionUpdateInterval = 1 / 50.0
    if motion.isDeviceMotionAvailable {
      motion.startDeviceMotionUpdates(to: motionQueue) { [weak self] value, _ in
        guard let self, let v = value else { return }
        let a = v.userAcceleration
        let g = v.gravity
        let r = v.rotationRate
        let toDegrees = 180 / Double.pi
        let raw = (
          v.timestamp, MotionAxis(x: a.x * 9.80665, y: a.y * 9.80665, z: a.z * 9.80665),
          MotionAxis(x: (a.x + g.x) * 9.80665, y: (a.y + g.y) * 9.80665, z: (a.z + g.z) * 9.80665),
          MotionRotation(alpha: r.z * toDegrees, beta: r.x * toDegrees, gamma: r.y * toDegrees)
        )
        self.lock.lock()
        if self.readings.count < 6500 { self.readings.append(raw) }
        self.gyroTurnRate = (r.x * r.x + r.y * r.y + r.z * r.z).squareRoot()
        self.lock.unlock()
      }
    }
  }
  var motionCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return readings.count
  }
  var seconds: Double { max(0, lastFrame - (origin ?? lastFrame)) }
  var poseCount: Int { poses.count }
  func frame(_ f: ARFrame, tracking: String, usePhotos: Bool) {
    let t = f.timestamp
    if origin == nil { origin = t }
    lastFrame = t
    if !attemptedWriter {
      attemptedWriter = true
      let image = f.capturedImage
      let w = CVPixelBufferGetWidth(image)
      let h = CVPixelBufferGetHeight(image)
      if let writer = try? AVAssetWriter(
        outputURL: directory.appendingPathComponent("camera.mp4"), fileType: .mp4)
      {
        let writerInput = AVAssetWriterInput(
          mediaType: .video,
          outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 6_000_000],
          ])
        writerInput.expectsMediaDataInRealTime = true
        let orientation =
          UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first {
            $0.activationState == .foregroundActive
          }?.interfaceOrientation ?? .portrait
        let outputSize =
          orientation.isPortrait ? CGSize(width: h, height: w) : CGSize(width: w, height: h)
        let transform = f.displayTransform(for: orientation, viewportSize: outputSize)
        writerInput.transform = CGAffineTransform(
          a: transform.a * outputSize.width / CGFloat(w),
          b: transform.b * outputSize.height / CGFloat(w),
          c: transform.c * outputSize.width / CGFloat(h),
          d: transform.d * outputSize.height / CGFloat(h), tx: transform.tx * outputSize.width,
          ty: transform.ty * outputSize.height)
        writer.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
          assetWriterInput: writerInput, sourcePixelBufferAttributes: nil)
        if writer.canAdd(writerInput) {
          writer.add(writerInput)
          if writer.startWriting() {
            writer.startSession(atSourceTime: .zero)
            video = writer
            input = writerInput
            pixels = adaptor
          }
        }
      }
    }
    if t - lastVideo >= 1 / 20.0, input?.isReadyForMoreMediaData == true, let start = origin {
      if pixels?.append(
        f.capturedImage, withPresentationTime: CMTime(seconds: t - start, preferredTimescale: 60000)
      ) == true {
        encodedFrames += 1
        lastVideo = t
      }
    }
    if let start = origin {
      let cam = f.camera
      let tf = cam.transform
      let k = cam.intrinsics
      poses.append(
        CameraSample(
          t: t - start, cameraToWorld: (0..<4).flatMap { c in (0..<4).map { r in tf[c][r] } },
          intrinsics: (0..<3).flatMap { c in (0..<3).map { r in k[c][r] } },
          imageWidth: Int(cam.imageResolution.width), imageHeight: Int(cam.imageResolution.height),
          tracking: tracking))
    }
    let blur = motionSmear(f, at: t)
    smear += (blur - smear) * 0.2
    if smear > gate.limit * 2 { smearing = true } else if smear < gate.limit * 1.2 { smearing = false }
    guard usePhotos, tracking == "normal", t - lastPhoto >= photoInterval else {
      gate.reset()
      return
    }
    let tf = f.camera.transform
    if let old = lastPhotoPose, simd_distance(old.columns.3, tf.columns.3) < 0.23,
      simd_dot(old.columns.2, tf.columns.2) > 0.965
    {
      gate.reset()
      return
    }
    // A photo is due. Wait briefly for a steady frame; the gate relaxes if none comes.
    guard gate.accept(time: t, blur: blur) else { return }
    let image = CIImage(cvPixelBuffer: f.capturedImage)
    let scale = min(1, 768 / image.extent.width)
    let url = directory.appendingPathComponent("photo-\(nextPhotoID).jpg")
    guard
      let jpeg = context.jpegRepresentation(
        of: image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)),
        colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, options: [:]),
      (try? jpeg.write(to: url, options: .atomic)) != nil
    else { return }
    var depths: [Float] = []
    var depthFile: String?
    var confidenceFile: String?
    var rawWidth: Int?
    var rawHeight: Int?
    var depthSize = SIMD2<Int>(repeating: 0)
    if let d = f.sceneDepth?.depthMap,
      CVPixelBufferLockBaseAddress(d, .readOnly) == kCVReturnSuccess
    {
      defer { CVPixelBufferUnlockBaseAddress(d, .readOnly) }
      let width = CVPixelBufferGetWidth(d)
      let height = CVPixelBufferGetHeight(d)
      let stride = CVPixelBufferGetBytesPerRow(d) / 4
      if let base = CVPixelBufferGetBaseAddress(d)?.assumingMemoryBound(to: Float.self) {
        let name = "depth-\(nextPhotoID).f32"
        var packed = Data(capacity: width * height * 4)
        for y in 0..<height {
          packed.append(
            UnsafeRawPointer(base.advanced(by: y * stride)).assumingMemoryBound(to: UInt8.self),
            count: width * 4)
        }
        if (try? packed.write(to: directory.appendingPathComponent(name), options: .atomic)) != nil
        {
          depthFile = name
          rawWidth = width
          rawHeight = height
        }
        depthSize = SIMD2(64, 48)
        for y in 0..<depthSize.y {
          for x in 0..<depthSize.x {
            depths.append(base[(y * height / depthSize.y) * stride + x * width / depthSize.x])
          }
        }
      }
    }
    if let map = f.sceneDepth?.confidenceMap, let w = rawWidth, let h = rawHeight,
      CVPixelBufferGetWidth(map) == w, CVPixelBufferGetHeight(map) == h,
      CVPixelBufferLockBaseAddress(map, .readOnly) == kCVReturnSuccess
    {
      defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
      if let bytes = CVPixelBufferGetBaseAddress(map)?.assumingMemoryBound(to: UInt8.self) {
        var packed = Data(capacity: w * h)
        let stride = CVPixelBufferGetBytesPerRow(map)
        for y in 0..<h { packed.append(bytes.advanced(by: y * stride), count: w) }
        let name = "confidence-\(nextPhotoID).u8"
        if (try? packed.write(to: directory.appendingPathComponent(name), options: .atomic)) != nil
        {
          confidenceFile = name
        }
      }
    }
    if let pose = poses.last {
      keyframes.append(
        CalibratedFrame(
          camera: pose, jpeg: url.lastPathComponent, depthMetersFloat32LE: depthFile,
          confidenceUInt8: confidenceFile, depthWidth: rawWidth, depthHeight: rawHeight,
          blurPixels: (blur * 10).rounded() / 10))
    }
    // Thin previously saved views in time, keeping room for the next part of the walk.
    if photos.count == 32 {
      photos = photos.enumerated().compactMap { $0.offset.isMultiple(of: 2) ? $0.element : nil }
    }
    nextPhotoID += 1
    photos.append(
      ScanPhoto(
        url: url, worldToCamera: tf.inverse, intrinsics: f.camera.intrinsics,
        size: SIMD2(Float(f.camera.imageResolution.width), Float(f.camera.imageResolution.height)),
        depth: depths, depthSize: depthSize))
    lastPhoto = t
    lastPhotoPose = tf
  }
  /// Smear from this frame's turning and sideways movement during its exposure, in saved-photo pixels.
  private func motionSmear(_ f: ARFrame, at t: Double) -> Double {
    let pose = f.camera.transform
    var rates = (turn: 0.0, sideways: 0.0)
    if let previous = previousPose {
      rates = MotionBlur.rates(from: previous.transform, to: pose, seconds: t - previous.t)
    }
    previousPose = (t, pose)
    lock.lock()
    let gyro = gyroTurnRate
    lock.unlock()
    var depth = 2.5
    if let map = f.sceneDepth?.depthMap, CVPixelBufferGetPixelFormatType(map) == kCVPixelFormatType_DepthFloat32,
      CVPixelBufferLockBaseAddress(map, .readOnly) == kCVReturnSuccess
    {
      defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
      if let base = CVPixelBufferGetBaseAddress(map)?.assumingMemoryBound(to: Float32.self) {
        let stride = CVPixelBufferGetBytesPerRow(map) / MemoryLayout<Float32>.stride
        let centre = base[(CVPixelBufferGetHeight(map) / 2) * stride + CVPixelBufferGetWidth(map) / 2]
        if centre.isFinite, centre > 0 { depth = Double(centre) }
      }
    }
    // Photos are saved at most 768 pixels wide, so judge smear at that size.
    let scale = min(1, 768 / Double(f.camera.imageResolution.width))
    return MotionBlur.pixels(
      focalPixels: Double(f.camera.intrinsics[0][0]) * scale, exposure: f.camera.exposureDuration,
      turnRate: max(gyro, rates.turn), sidewaysSpeed: rates.sideways, depth: depth)
  }
  func stopMotion() { motion.stopDeviceMotionUpdates() }
  func endMedia() async throws -> (hasVideo: Bool, motion: Int) {
    if let writer = video, writer.status == .writing {
      input?.markAsFinished()
      await writer.finishWriting()
    }
    let hasVideo = encodedFrames > 1 && video?.status == .completed
    let start = origin ?? 0
    let samples = snapshotMotion().filter { $0.0 >= start && $0.0 <= lastFrame }.map {
      MotionReading(
        tMs: ($0.0 - start) * 1000, acceleration: $0.1, accelerationIncludingGravity: $0.2,
        rotationRate: $0.3)
    }
    let payload = MotionFile(
      permission: samples.isEmpty ? "unavailable" : "granted", durationMs: max(1, seconds * 1000),
      samples: samples)
    try JSONEncoder().encode(payload).write(
      to: directory.appendingPathComponent("motion.json"), options: .atomic)
    try JSONEncoder().encode(poses).write(
      to: directory.appendingPathComponent("camera-poses.json"), options: .atomic)
    try JSONEncoder().encode(keyframes).write(
      to: directory.appendingPathComponent("keyframes.json"), options: .atomic)
    return (hasVideo, samples.count)
  }
  private func snapshotMotion() -> [(Double, MotionAxis, MotionAxis, MotionRotation)] {
    lock.lock()
    defer { lock.unlock() }
    return readings
  }
  deinit { motion.stopDeviceMotionUpdates() }
}
