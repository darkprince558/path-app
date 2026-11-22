import Foundation
import simd

// Sensor logic with no ARKit, CoreMotion or CoreLocation, so the Mac checks can run it.
// ARKit keeps doing the position tracking. Each sensor here has one narrow job:
// the barometer notices floor changes, the gyro and exposure time pick sharp photos,
// GPS and compass tag an outdoor entrance, and the thermal state warns before iOS throttles.

// MARK: Barometer

/// One barometer reading. `t` is seconds since boot, the clock `ARFrame.timestamp` uses.
/// `altitude` is metres relative to where the walk's updates started, never an absolute height.
struct AltitudeSample: Codable, Equatable {
  let t: Double
  let altitude: Double
  let pressureKPa: Double
}

struct FloorChange: Codable, Equatable {
  /// `walked`: ARKit saw the height change too (stairs or a steep ramp).
  /// `elevator`: the barometer moved while ARKit's own height stayed put.
  /// `unknown`: no ARKit height was available to compare.
  enum Kind: String, Codable { case walked, elevator, unknown }
  let start: Double
  let end: Double
  /// Positive is up.
  let metres: Double
  let kind: Kind
  /// ARKit's height change over the same interval, when tracking supplied one.
  let trackedMetres: Double?

  var summary: String {
    let way = metres > 0 ? "Up" : "Down"
    let size = String(format: "%.1f m", abs(metres))
    switch kind {
    case .walked: return "\(way) \(size) by stairs or ramp"
    case .elevator: return "\(way) \(size) by elevator"
    case .unknown: return "\(way) \(size)"
    }
  }
}

/// Notices that the walker changed floors. It never names a floor: pressure differs by
/// metres between phones and drifts with weather, but the step between two floors is stable.
/// The thresholds are starting values to tune on a real stairwell and elevator.
struct FloorChangeDetector {
  /// A settled height change at least this large is a floor change.
  static let threshold = 2.0
  /// How far back to look when deciding whether the walker is standing on a floor.
  static let settleSeconds = 6.0
  /// The look-back must cover at least this long, so one or two readings never count as settled.
  static let minimumSpan = 4.0
  /// Settled means one-second averages stay within this range and show no steady climb.
  static let settleRange = 0.5
  static let settleTrend = 0.2
  /// Weather and ventilation move pressure slowly. The remembered floor level may follow at
  /// most this fast, in metres per second, so a slow staircase is not mistaken for drift.
  static let driftRate = 0.02
  /// Below this much ARKit height change, a barometer change was a ride, not a climb.
  static let elevatorTrackedLimit = 0.5

  private var window: [(sample: AltitudeSample, tracked: Double?)] = []
  private var reference: (t: Double, altitude: Double, tracked: Double?)?
  private var tracked: Double?
  private(set) var events: [FloorChange] = []
  private var handedOut = 0

  /// Feed every barometer reading in order. `trackedHeight` is ARKit's camera height at
  /// about the same moment, or nil while tracking is unreliable.
  mutating func add(_ sample: AltitudeSample, trackedHeight: Double?) -> FloorChange? {
    guard sample.t.isFinite, sample.altitude.isFinite else { return nil }
    tracked = trackedHeight.flatMap { $0.isFinite ? $0 : nil }
    // A long silence (the altimeter stalled, or the walk paused) says nothing about the gap.
    if let last = window.last?.sample, sample.t - last.t > 10 || sample.t < last.t { window.removeAll() }
    window.append((sample, tracked))
    window.removeAll { sample.t - $0.sample.t > Self.settleSeconds }
    guard let first = window.first?.sample, sample.t - first.t >= Self.minimumSpan else { return nil }
    // Average each second first, so a phone that reports ten times a second is judged the
    // same way as one that reports once a second instead of looking ten times noisier.
    var seconds: [Int: (total: Double, count: Int)] = [:]
    for entry in window {
      let second = Int((entry.sample.t - first.t).rounded(.down))
      seconds[second, default: (0, 0)].total += entry.sample.altitude
      seconds[second, default: (0, 0)].count += 1
    }
    let means = seconds.keys.sorted().map { seconds[$0]!.total / Double(seconds[$0]!.count) }
    guard means.count >= 3, let low = means.min(), let high = means.max(),
      high - low <= Self.settleRange
    else { return nil }
    // A slow, steady climb stays inside the range, so also compare the later half with the earlier half.
    let half = means.count / 2
    let earlier = means.prefix(half).reduce(0, +) / Double(half)
    let later = means.suffix(half).reduce(0, +) / Double(half)
    guard abs(later - earlier) <= Self.settleTrend else { return nil }
    let level = means.sorted()[means.count / 2]
    let seen = window.compactMap(\.tracked).sorted()
    // Tracking that dropped out for most of the settled window cannot vouch for a height.
    let trackedLevel = seen.count * 2 >= window.count ? seen[seen.count / 2] : nil
    guard let from = reference else {
      reference = (sample.t, level, trackedLevel)
      return nil
    }
    let change = level - from.altitude
    if abs(change) < Self.threshold {
      // Not a floor yet. Let the remembered level creep toward this one at drift speed only,
      // so two half-flights with a pause on the landing still add up to one floor.
      let allowed = Self.driftRate * min(max(0, sample.t - from.t), 2)
      let followed = from.altitude + max(-allowed, min(allowed, change))
      reference = (sample.t, followed, trackedLevel.map { $0 - (level - followed) })
      return nil
    }
    let trackedChange = trackedLevel.flatMap { now in from.tracked.map { now - $0 } }
    let kind: FloorChange.Kind =
      trackedChange.map { abs($0) < Self.elevatorTrackedLimit ? .elevator : .walked } ?? .unknown
    let event = FloorChange(
      start: from.t, end: first.t, metres: change, kind: kind, trackedMetres: trackedChange)
    reference = (sample.t, level, trackedLevel)
    events.append(event)
    return event
  }

  /// The events noticed since the last call. A floor change is recognised a few seconds
  /// after it ends, which can be after its section closed; it goes to whichever section asks next.
  mutating func takeNewEvents() -> [FloorChange] {
    defer { handedOut = events.count }
    return Array(events[handedOut...])
  }
}

struct AltitudeFile: Codable {
  var version = 1
  var timebase = "section-start-seconds"
  var altitudeReference = "metres relative to the start of the walk, not an absolute height"
  let samples: [AltitudeSample]
  /// Times are relative to this section's start, so a change that began or ended before the
  /// section opened has a negative time.
  let floorChanges: [FloorChange]

  /// The readings between `start` and `end`, and the given floor changes, in section time.
  init(samples: [AltitudeSample], floorChanges: [FloorChange], from start: Double, to end: Double) {
    self.samples = samples.filter { $0.t >= start && $0.t <= end }.map {
      AltitudeSample(t: $0.t - start, altitude: $0.altitude, pressureKPa: $0.pressureKPa)
    }
    self.floorChanges = floorChanges.map {
      FloorChange(start: $0.start - start, end: $0.end - start, metres: $0.metres, kind: $0.kind,
        trackedMetres: $0.trackedMetres)
    }
  }
}

// MARK: Sharp photos

enum MotionBlur {
  /// Roughly how many pixels the image smears during one exposure: turning sweeps the whole
  /// view, and sideways movement sweeps nearby surfaces faster than distant ones.
  static func pixels(
    focalPixels: Double, exposure: Double, turnRate: Double, sidewaysSpeed: Double, depth: Double
  ) -> Double {
    guard focalPixels.isFinite, exposure.isFinite, turnRate.isFinite, sidewaysSpeed.isFinite,
      focalPixels > 0, exposure > 0
    else { return 0 }
    let distance = depth.isFinite && depth > 0.3 ? depth : 0.3
    return focalPixels * exposure * (abs(turnRate) + abs(sidewaysSpeed) / distance)
  }

  /// Turn rate (radians per second) and sideways speed (metres per second) between two camera poses.
  static func rates(from previous: simd_float4x4, to current: simd_float4x4, seconds: Double)
    -> (turn: Double, sideways: Double)
  {
    guard seconds > 0 else { return (0, 0) }
    func axes(_ m: simd_float4x4) -> simd_float3x3 {
      simd_float3x3(
        SIMD3(m.columns.0.x, m.columns.0.y, m.columns.0.z),
        SIMD3(m.columns.1.x, m.columns.1.y, m.columns.1.z),
        SIMD3(m.columns.2.x, m.columns.2.y, m.columns.2.z))
    }
    let relative = axes(previous).transpose * axes(current)
    let trace = relative.columns.0.x + relative.columns.1.y + relative.columns.2.z
    let angle = acos(Double(max(-1, min(1, (trace - 1) / 2))))
    let step = SIMD3(
      current.columns.3.x - previous.columns.3.x, current.columns.3.y - previous.columns.3.y,
      current.columns.3.z - previous.columns.3.z)
    // The camera looks along its own -Z axis; movement along it barely smears the image.
    let forward = -simd_normalize(SIMD3(current.columns.2.x, current.columns.2.y, current.columns.2.z))
    let sideways = step - forward * simd_dot(step, forward)
    return (angle / seconds, Double(simd_length(sideways)) / seconds)
  }
}

/// Decides which frame to keep once a photo is due. It waits briefly for a steady frame
/// instead of taking the first one, then relaxes so a moving walker still gets coverage.
/// Frames are judged as they arrive, so no camera buffer is held back.
struct KeyframeGate {
  /// Smear, in pixels of the saved photo, under which a frame counts as sharp.
  var limit = 3.0
  /// How long to wait for a sharp frame before accepting a softer one.
  var patience = 0.6
  /// After this long, take whatever comes.
  var giveUp = 1.2
  private var waitingSince: Double?

  mutating func accept(time: Double, blur: Double) -> Bool {
    let since = waitingSince ?? time
    waitingSince = since
    let waited = time - since
    let allowed = waited < patience ? limit : (waited < giveUp ? limit * 2 : Double.infinity)
    guard blur <= allowed else { return false }
    waitingSince = nil
    return true
  }

  /// Call when a photo stops being due, so an old wait cannot excuse a blurry frame later.
  mutating func reset() { waitingSince = nil }
}

// MARK: Entrance tag

struct LocationFix: Codable, Equatable {
  let latitude, longitude: Double
  /// Radius of uncertainty in metres, as CoreLocation reports it.
  let horizontalAccuracy: Double
  let timestamp: Date
}

struct HeadingFix: Codable, Equatable {
  /// Degrees clockwise from true north.
  let trueHeading: Double
  /// Degrees of uncertainty. Expect 15 or more even outdoors.
  let accuracy: Double
}

/// Where a walk started, from GPS and compass. It labels the entrance for "get to the
/// building"; it is never used to position or rotate the indoor map.
struct EntranceTag: Codable, Equatable {
  var location: LocationFix?
  var heading: HeadingFix?
  var isEmpty: Bool { location == nil && heading == nil }
}

/// Keeps the most trustworthy fix offered during the few seconds a walk spends starting.
struct BestFix {
  /// A fix less certain than this says nothing useful about where a door is.
  static let worstUsable = 100.0
  /// A fix older than this was cached from before the walk.
  static let oldest = 15.0
  private(set) var location: LocationFix?
  private(set) var heading: HeadingFix?

  mutating func offer(_ fix: LocationFix, now: Date) {
    guard fix.horizontalAccuracy > 0, fix.horizontalAccuracy <= Self.worstUsable,
      abs(fix.latitude) <= 90, abs(fix.longitude) <= 180,
      now.timeIntervalSince(fix.timestamp) <= Self.oldest
    else { return }
    if fix.horizontalAccuracy < (location?.horizontalAccuracy ?? .infinity) { location = fix }
  }

  mutating func offer(_ fix: HeadingFix) {
    // CoreLocation reports a negative accuracy or heading when the reading is invalid.
    guard fix.accuracy >= 0, (0..<360).contains(fix.trueHeading) else { return }
    if fix.accuracy < (heading?.accuracy ?? .infinity) { heading = fix }
  }

  var tag: EntranceTag { EntranceTag(location: location, heading: heading) }
}

// MARK: Heat

enum ThermalLevel: String, Codable, Comparable {
  case nominal, fair, serious, critical

  init(_ state: ProcessInfo.ThermalState) {
    switch state {
    case .nominal: self = .nominal
    case .fair: self = .fair
    case .serious: self = .serious
    case .critical: self = .critical
    @unknown default: self = .fair
    }
  }
  private var rank: Int {
    switch self {
    case .nominal: return 0
    case .fair: return 1
    case .serious: return 2
    case .critical: return 3
    }
  }
  static func < (a: ThermalLevel, b: ThermalLevel) -> Bool { a.rank < b.rank }
  /// iOS starts cutting performance at `serious`, which shows up as dropped frames and lost tracking.
  var warning: String? {
    self >= .serious ? "The phone is hot. Finish this stretch, then let it cool before continuing." : nil
  }
}
