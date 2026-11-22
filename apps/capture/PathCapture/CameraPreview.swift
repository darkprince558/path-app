import ARKit
import RealityKit
import SwiftUI

struct CameraPreview: UIViewRepresentable {
  let session: ARSession
  let mesh: Bool
  func makeUIView(context: Context) -> ARView {
    let v = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
    let scanDelegate = session.delegate
    v.session = session
    session.delegate = scanDelegate
    if mesh {
      v.debugOptions.insert(.showSceneUnderstanding)
    } else {
      v.debugOptions.insert(.showFeaturePoints)
    }
    return v
  }
  func updateUIView(_ view: ARView, context: Context) {}
}
