import ARKit
import RealityKit
import SwiftUI

@main
struct PathCaptureApp: App {
    var body: some SwiftUI.Scene {
        WindowGroup { CaptureScreen() }
    }
}

private struct CaptureScreen: View {
    @StateObject private var scanner = CaptureController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 0) {
            if scanner.phase == .recording {
                CameraPreview(session: scanner.session)
                    .accessibilityHidden(true)
                    .frame(maxHeight: .infinity)
            } else {
                Spacer(minLength: 16)
                Image(systemName: scanner.supportsDepth ? "viewfinder" : "camera.fill")
                    .font(.system(size: 54, weight: .light))
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Spacer(minLength: 16)
            }

            VStack(alignment: .leading, spacing: 14) {
                Text("Path Capture")
                    .font(.title2.bold())

                if scanner.supportsDepth {
                    Text(scanner.instruction)
                        .foregroundStyle(.secondary)

                    if scanner.phase == .recording || scanner.pointCount > 0 {
                        Text("\(scanner.pointCount.formatted()) points")
                            .font(.subheadline.monospacedDigit())
                    }

                    if scanner.phase == .recording {
                        Button("Stop scan", action: scanner.stop)
                            .buttonStyle(.borderedProminent)
                    } else {
                        if scanner.phase == .finished && scanner.pointCount > 0 {
                            Button("Share PLY", action: scanner.export)
                                .buttonStyle(.borderedProminent)
                        }
                        Button(scanner.phase == .finished ? "New scan" : "Start scan") {
                            Task { await scanner.start() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(scanner.phase == .requestingCamera)
                    }
                } else {
                    Text("Use a LiDAR-equipped iPhone or iPad to record a scan.")
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
            .background(.background)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                scanner.stop()
            }
        }
        .sheet(item: $scanner.exportedScan) { scan in
            ShareSheet(url: scan.url)
        }
    }
}

private struct CameraPreview: UIViewRepresentable {
    let session: ARSession

    func makeUIView(context: Context) -> ARView {
        let view = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
        view.session = session
        return view
    }

    func updateUIView(_ view: ARView, context: Context) {}
}

private struct ShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
