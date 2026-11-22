import SwiftUI

/// The recognizers share a pivot and report incremental changes so a two-finger
/// pan, turn and pinch can all edit the same camera without restarting a gesture.
struct MapGestures: UIViewRepresentable {
  var summary: String
  var change: (CGPoint, CGPoint, CGFloat, CGFloat) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(change) }
  func makeUIView(context: Context) -> UIView {
    let view = UIView()
    let handler = context.coordinator
    let gestures: [UIGestureRecognizer] = [
      UIPanGestureRecognizer(target: handler, action: #selector(handler.pan)),
      UIPinchGestureRecognizer(target: handler, action: #selector(handler.pinch)),
      UIRotationGestureRecognizer(target: handler, action: #selector(handler.turn))
    ]
    let doubleTap = UITapGestureRecognizer(target: handler, action: #selector(handler.zoomIn))
    doubleTap.numberOfTapsRequired = 2
    for gesture in gestures + [doubleTap] {
      gesture.delegate = handler
      view.addGestureRecognizer(gesture)
    }
    view.isAccessibilityElement = true
    view.accessibilityIdentifier = "map-surface"
    view.accessibilityTraits = .image
    return view
  }
  func updateUIView(_ view: UIView, context: Context) {
    context.coordinator.change = change
    view.accessibilityLabel = summary
  }

  final class Coordinator: NSObject, UIGestureRecognizerDelegate {
    var change: (CGPoint, CGPoint, CGFloat, CGFloat) -> Void
    init(_ change: @escaping (CGPoint, CGPoint, CGFloat, CGFloat) -> Void) { self.change = change }
    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
      gesture.view === other.view
    }
    @objc func pan(_ gesture: UIPanGestureRecognizer) {
      guard gesture.state == .changed else { return }
      let end = gesture.location(in: gesture.view)
      let delta = gesture.translation(in: gesture.view)
      gesture.setTranslation(.zero, in: gesture.view)
      change(CGPoint(x: end.x - delta.x, y: end.y - delta.y), end, 1, 0)
    }
    @objc func pinch(_ gesture: UIPinchGestureRecognizer) {
      guard gesture.state == .changed else { return }
      let pivot = gesture.location(in: gesture.view)
      change(pivot, pivot, gesture.scale, 0)
      gesture.scale = 1
    }
    @objc func turn(_ gesture: UIRotationGestureRecognizer) {
      guard gesture.state == .changed else { return }
      let pivot = gesture.location(in: gesture.view)
      change(pivot, pivot, 1, gesture.rotation)
      gesture.rotation = 0
    }
    @objc func zoomIn(_ gesture: UITapGestureRecognizer) {
      let pivot = gesture.location(in: gesture.view)
      change(pivot, pivot, 2, 0)
    }
  }
}
