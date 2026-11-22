import ARKit
import RealityKit
import SwiftUI

struct CameraPreview: UIViewRepresentable {
  let session: ARSession
  let mesh: Bool
  let overlay: Bool

  func makeUIView(context: Context) -> ARView {
    let view = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
    let scanDelegate = session.delegate
    view.session = session
    session.delegate = scanDelegate
    updateUIView(view, context: context)
    return view
  }

  func updateUIView(_ view: ARView, context: Context) {
    let option: ARView.DebugOptions = mesh ? .showSceneUnderstanding : .showFeaturePoints
    if overlay { view.debugOptions.insert(option) } else { view.debugOptions.remove(option) }
  }
}
