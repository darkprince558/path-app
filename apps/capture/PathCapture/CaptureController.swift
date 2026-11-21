import ARKit
import AVFoundation
import SwiftUI

final class CaptureController: NSObject, ObservableObject, ARSessionDelegate {
    enum Phase {
        case ready, requestingCamera, recording, finished
    }

    struct ExportedScan: Identifiable {
        let url: URL
        var id: URL { url }
    }

    let session = ARSession()
    let supportsDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)

    @Published private(set) var phase: Phase = .ready
    @Published private(set) var pointCount = 0
    @Published private(set) var instruction = "Start facing into the route. Walk slowly around one turn."
    @Published var exportedScan: ExportedScan?

    private var cloud = PointCloud()
    private var lastSampleTime = -Double.infinity
    private var exportURL: URL?

    override init() {
        super.init()
        // The capture state and SwiftUI updates stay on the main queue.
        session.delegateQueue = .main
        session.delegate = self
    }

    @MainActor
    func start() async {
        guard supportsDepth, phase == .ready || phase == .finished else { return }
        let previousPhase = phase
        phase = .requestingCamera
        let allowed = await AVCaptureDevice.requestAccess(for: .video)
        guard phase == .requestingCamera else { return }
        guard allowed else {
            phase = previousPhase
            instruction = "Allow camera access for Path Capture in Settings, then try again."
            return
        }

        cloud = PointCloud()
        pointCount = 0
        lastSampleTime = -Double.infinity
        exportURL = nil

        let configuration = ARWorldTrackingConfiguration()
        configuration.worldAlignment = .gravity
        configuration.frameSemantics = .sceneDepth
        phase = .recording
        instruction = "Hold still while tracking starts."
        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    }

    func stop() {
        guard phase == .recording else { return }
        phase = .finished
        session.pause()
        instruction = cloud.count == 0
            ? "No points captured. Try again in better light and move slowly."
            : "Save the PLY to Files, then select it in the Path App website."
    }

    func export() {
        guard phase == .finished, cloud.count > 0 else { return }
        do {
            if let exportURL {
                exportedScan = ExportedScan(url: exportURL)
                return
            }
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("PathCapture", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("PathScan-\(UUID().uuidString.prefix(8)).ply")
            try cloud.binaryPLY().write(to: url, options: .atomic)
            exportURL = url
            exportedScan = ExportedScan(url: url)
        } catch {
            instruction = "Couldn’t export the scan. Free up storage and try again."
        }
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard phase == .recording, frame.timestamp - lastSampleTime >= 0.2 else { return }
        lastSampleTime = frame.timestamp

        guard case .normal = frame.camera.trackingState else {
            instruction = "Tracking limited. Slow down and point at a well-lit feature."
            return
        }
        guard let depth = frame.sceneDepth, let confidence = depth.confidenceMap else {
            instruction = "Waiting for LiDAR depth."
            return
        }

        sample(frame, depth: depth.depthMap, confidence: confidence)
        pointCount = cloud.count
        instruction = "Walk slowly and keep the turn and its landmarks in view."
        if cloud.isFull {
            stop()
            instruction = "Scan is full. Save the PLY and upload it to Path App."
        }
    }

    func sessionWasInterrupted(_ session: ARSession) {
        guard phase == .recording else { return }
        stop()
        instruction = cloud.count > 0
            ? "Capture was interrupted. You can export the points already recorded."
            : "Capture was interrupted. Start a new scan."
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        guard phase == .recording else { return }
        stop()
        instruction = cloud.count > 0
            ? "Tracking stopped. You can export the points already recorded."
            : "ARKit couldn’t start. Check camera access and try again."
    }

    private func sample(_ frame: ARFrame, depth: CVPixelBuffer, confidence: CVPixelBuffer) {
        let image = frame.capturedImage
        let imageFormat = CVPixelBufferGetPixelFormatType(image)
        let fullRange = imageFormat == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        guard fullRange || imageFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
              CVPixelBufferLockBaseAddress(depth, .readOnly) == kCVReturnSuccess else { return }
        defer { CVPixelBufferUnlockBaseAddress(depth, .readOnly) }
        guard CVPixelBufferLockBaseAddress(confidence, .readOnly) == kCVReturnSuccess else { return }
        defer { CVPixelBufferUnlockBaseAddress(confidence, .readOnly) }
        guard CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess else { return }
        defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }

        guard let depthBase = CVPixelBufferGetBaseAddress(depth)?.assumingMemoryBound(to: Float32.self),
              let confidenceBase = CVPixelBufferGetBaseAddress(confidence)?.assumingMemoryBound(to: UInt8.self),
              let luma = CVPixelBufferGetBaseAddressOfPlane(image, 0)?.assumingMemoryBound(to: UInt8.self),
              let chroma = CVPixelBufferGetBaseAddressOfPlane(image, 1)?.assumingMemoryBound(to: UInt8.self)
        else { return }

        let width = CVPixelBufferGetWidth(depth)
        let height = CVPixelBufferGetHeight(depth)
        guard CVPixelBufferGetWidth(confidence) == width,
              CVPixelBufferGetHeight(confidence) == height,
              CVPixelBufferGetPixelFormatType(depth) == kCVPixelFormatType_DepthFloat32 else { return }

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
                      confidenceBase[y * confidenceStride + x] >= minimumConfidence else { continue }

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

    private static func rgb(_ luma: UInt8, _ cb: UInt8, _ cr: UInt8, fullRange: Bool) -> SIMD3<UInt8> {
        let y = fullRange ? Float(luma) : (Float(luma) - 16) * 255 / 219
        let chromaScale: Float = fullRange ? 1 : 255 / 224
        let u = (Float(cb) - 128) * chromaScale
        let v = (Float(cr) - 128) * chromaScale
        func channel(_ value: Float) -> UInt8 {
            UInt8(clamping: Int(value.rounded()))
        }
        return SIMD3(channel(y + 1.402 * v), channel(y - 0.344136 * u - 0.714136 * v), channel(y + 1.772 * u))
    }
}
