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
final class TakeRecorder {
  let id = UUID()
  let created = Date()
  let directory: URL
  private let motion = CMMotionManager()
  private let motionQueue = OperationQueue()
  private var readings: [(Double, MotionAxis, MotionAxis, MotionRotation)] = []
  private let lock = NSLock()
  private var poses: [CameraSample] = []
  private let context = CIContext(options: [.cacheIntermediates: false])
  private var photoInterval = 0.8
  private var nextPhotoID = 0
  private var lastPhotoPose: simd_float4x4?
  private(set) var photos: [ScanPhoto] = []
  private(set) var origin: Double?
  private var lastFrame = 0.0, lastPose = 0.0, lastVideo = 0.0, lastPhoto = 0.0
  private var video: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var pixels: AVAssetWriterInputPixelBufferAdaptor?
  private var attemptedWriter = false
  private var encodedFrames = 0
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
    if t - lastPose >= 0.095, let start = origin {
      let cam = f.camera
      let tf = cam.transform
      let k = cam.intrinsics
      poses.append(
        CameraSample(
          t: t - start, cameraToWorld: (0..<4).flatMap { c in (0..<4).map { r in tf[c][r] } },
          intrinsics: (0..<3).flatMap { c in (0..<3).map { r in k[c][r] } },
          imageWidth: Int(cam.imageResolution.width), imageHeight: Int(cam.imageResolution.height),
          tracking: tracking))
      lastPose = t
    }
    guard usePhotos, tracking == "normal", t - lastPhoto >= photoInterval else { return }
    let tf = f.camera.transform
    if let old = lastPhotoPose, simd_distance(old.columns.3, tf.columns.3) < 0.23,
      simd_dot(old.columns.2, tf.columns.2) > 0.965
    {
      return
    }
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
    var depthSize = SIMD2<Int>(repeating: 0)
    if let d = f.sceneDepth?.depthMap,
      CVPixelBufferLockBaseAddress(d, .readOnly) == kCVReturnSuccess
    {
      defer { CVPixelBufferUnlockBaseAddress(d, .readOnly) }
      let width = CVPixelBufferGetWidth(d)
      let height = CVPixelBufferGetHeight(d)
      let stride = CVPixelBufferGetBytesPerRow(d) / 4
      if let base = CVPixelBufferGetBaseAddress(d)?.assumingMemoryBound(to: Float.self) {
        depthSize = SIMD2(64, 48)
        for y in 0..<depthSize.y {
          for x in 0..<depthSize.x {
            depths.append(base[(y * height / depthSize.y) * stride + x * width / depthSize.x])
          }
        }
      }
    }
    // Thin previously saved views in time, keeping room for the next part of the walk.
    if photos.count == 32 {
      photos = photos.enumerated().compactMap { $0.offset.isMultiple(of: 2) ? $0.element : nil }
      photoInterval *= 2
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
  func endMedia() async throws -> (hasVideo: Bool, motion: Int) {
    motion.stopDeviceMotionUpdates()
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
    return (hasVideo, samples.count)
  }
  private func snapshotMotion() -> [(Double, MotionAxis, MotionAxis, MotionRotation)] {
    lock.lock()
    defer { lock.unlock() }
    return readings
  }
  deinit { motion.stopDeviceMotionUpdates() }
}
