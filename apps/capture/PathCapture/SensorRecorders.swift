import CoreLocation
import CoreMotion
import Foundation

/// Reads the barometer for one whole walk, so heights stay comparable across its sections.
final class AltitudeRecorder {
  static var available: Bool { CMAltimeter.isRelativeAltitudeAvailable() }
  /// Called on the main queue each time the walker settles on a different floor.
  var onFloorChange: ((FloorChange) -> Void)?
  private let altimeter = CMAltimeter()
  private let queue = OperationQueue()
  private let lock = NSLock()
  private var samples: [AltitudeSample] = []
  private var detector = FloorChangeDetector()
  private var trackedHeight: Double?
  private var clockOffset: Double?

  init() { queue.maxConcurrentOperationCount = 1 }

  func start() {
    guard Self.available else { return }
    altimeter.startRelativeAltitudeUpdates(to: queue) { [weak self] data, _ in
      guard let self, let data else { return }
      self.lock.lock()
      // Core Motion timestamps count seconds since boot, as ARKit frame timestamps do. If this
      // phone's altimeter reports on another clock, shift it once so sections can still be cut.
      if self.clockOffset == nil {
        let gap = ProcessInfo.processInfo.systemUptime - data.timestamp
        self.clockOffset = abs(gap) > 5 ? gap : 0
      }
      let sample = AltitudeSample(
        t: data.timestamp + (self.clockOffset ?? 0), altitude: data.relativeAltitude.doubleValue,
        pressureKPa: data.pressure.doubleValue)
      // Ten hours at ten readings a second; a walk ends long before this.
      if self.samples.count < 360_000 { self.samples.append(sample) }
      let event = self.detector.add(sample, trackedHeight: self.trackedHeight)
      self.lock.unlock()
      if let event { DispatchQueue.main.async { self.onFloorChange?(event) } }
    }
  }

  /// ARKit's camera height, or nil while tracking is unreliable, for telling stairs from elevators.
  func track(height: Double?) {
    lock.lock()
    trackedHeight = height
    lock.unlock()
  }

  var received: Int {
    lock.lock()
    defer { lock.unlock() }
    return samples.count
  }

  /// One section's readings, plus every floor change noticed since the last section was
  /// handed its own, so a change recognised just after a section closed is still saved once.
  func file(from start: Double, to end: Double) -> AltitudeFile {
    lock.lock()
    defer { lock.unlock() }
    return AltitudeFile(
      samples: samples, floorChanges: detector.takeNewEvents(), from: start, to: end)
  }

  func stop() { altimeter.stopRelativeAltitudeUpdates() }
  deinit { altimeter.stopRelativeAltitudeUpdates() }
}

/// Takes a few seconds of GPS and compass readings as a walk starts, to label its entrance.
/// It runs only when the user has switched "Tag where this walk starts" on.
final class EntranceTagger: NSObject, CLLocationManagerDelegate {
  static let settingKey = "scan.tagEntrance"
  /// Long enough for a first outdoor fix to tighten, short enough to finish near the door.
  private static let listenSeconds = 12.0
  private let manager = CLLocationManager()
  private var best = BestFix()
  private var listening = false
  private var deadline: DispatchWorkItem?

  override init() {
    super.init()
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyBest
  }

  var tag: EntranceTag { best.tag }

  /// Call on the main queue. Asks for "While Using" access the first time.
  func begin() {
    best = BestFix()
    listening = true
    switch manager.authorizationStatus {
    case .notDetermined: manager.requestWhenInUseAuthorization()
    case .authorizedWhenInUse, .authorizedAlways: listen()
    default: listening = false
    }
  }

  func stop() {
    deadline?.cancel()
    deadline = nil
    listening = false
    manager.stopUpdatingLocation()
    manager.stopUpdatingHeading()
  }

  private func listen() {
    manager.startUpdatingLocation()
    if CLLocationManager.headingAvailable() { manager.startUpdatingHeading() }
    deadline?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.stop() }
    deadline = work
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.listenSeconds, execute: work)
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    guard listening else { return }
    switch manager.authorizationStatus {
    case .authorizedWhenInUse, .authorizedAlways: listen()
    case .denied, .restricted: stop()
    default: break
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard listening else { return }
    let now = Date()
    for fix in locations {
      best.offer(
        LocationFix(
          latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude,
          horizontalAccuracy: fix.horizontalAccuracy, timestamp: fix.timestamp), now: now)
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateHeading heading: CLHeading) {
    guard listening else { return }
    best.offer(HeadingFix(trueHeading: heading.trueHeading, accuracy: heading.headingAccuracy))
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // No fix is an acceptable outcome: the walk simply has no entrance tag.
  }
}
