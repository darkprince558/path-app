import Combine

enum ScanPhase { case ready, requestingCamera, recording, paused, saving, finished }

enum TrackingQuality: String, Codable {
  case waiting, starting, normal, limited, unavailable

  var label: String { self == .normal ? "Tracking" : rawValue.capitalized }
}

protocol ScanSource: ObservableObject {
  var phase: ScanPhase { get }
  var liveMap: WalkMap { get }
  var mapLayers: [WalkLayer] { get }
  var tracking: TrackingQuality { get }
  var instruction: String { get }
  var rescanSide: RescanSide? { get }
  var duration: Double { get }
  var sectionNumber: Int { get }
  var savedSections: Int { get }
  func stop(reason: String?)
}

extension ScanSource {
  var walkedDistance: Float { mapLayers.reduce(0) { $0 + $1.map.distance } }
}
