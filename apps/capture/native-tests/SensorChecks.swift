import Foundation
import simd

// Sensor rules for the scanner, run on the Mac: no ARKit, CoreMotion or CoreLocation.
// Called from main.swift so the names here cannot clash with its fixtures.

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  if !condition() {
    FileHandle.standardError.write(Data("FAILED: \(message)\n".utf8))
    exit(1)
  }
}

func runSensorChecks() throws {
  /// Feeds a height profile at 1 Hz (the slowest rate documented for the altimeter).
  func floorChanges(
    _ heights: [Double], tracked: (Int) -> Double? = { _ in nil }, rate: Double = 1
  ) -> [FloorChange] {
    var detector = FloorChangeDetector()
    for (i, altitude) in heights.enumerated() {
      _ = detector.add(
        AltitudeSample(t: 100 + Double(i) / rate, altitude: altitude, pressureKPa: 101.3),
        trackedHeight: tracked(i))
    }
    return detector.events
  }
  func ramp(from a: Double, to b: Double, steps: Int) -> [Double] {
    (1...steps).map { a + (b - a) * Double($0) / Double(steps) }
  }
  let flat = { (level: Double, seconds: Int) in [Double](repeating: level, count: seconds) }

  // Standing on one floor for ten minutes with sensor noise: nothing.
  let noisy = (0..<600).map { 0.15 * sin(Double($0) * 1.7) }
  check(floorChanges(noisy).isEmpty, "noise on one floor is not a floor change")

  // Weather drift of 1.4 m in 15 minutes (the figure from Muralidharan et al.) stays one floor,
  // even though it would cross the threshold if it were allowed to add up.
  let drift = (0..<1800).map { 3.0 * Double($0) / 1800 }
  check(floorChanges(drift).isEmpty, "slow pressure drift never becomes a floor change")

  // One flight of stairs: 3.6 m in 12 s, with ARKit seeing the same climb.
  let stairs = flat(0, 10) + ramp(from: 0, to: 3.6, steps: 12) + flat(3.6, 12)
  let climbed = floorChanges(stairs) { i in stairs[i] + 1.4 }
  check(climbed.count == 1, "one flight is one event, got \(climbed.count)")
  check(abs(climbed[0].metres - 3.6) < 0.2 && climbed[0].kind == .walked, "stairs are walked, +3.6 m")
  check(abs((climbed[0].trackedMetres ?? 0) - 3.6) < 0.2, "ARKit's height change is recorded")
  check(climbed[0].start >= 100 && climbed[0].end > climbed[0].start, "the event has an interval")
  check(climbed[0].summary == "Up 3.6 m by stairs or ramp", "summary reads \(climbed[0].summary)")

  // An elevator: the barometer drops two floors while ARKit sees a cabin that does not move.
  let ride = flat(7.2, 10) + ramp(from: 7.2, to: 0, steps: 8) + flat(0, 12)
  let rode = floorChanges(ride) { _ in 1.4 }
  check(rode.count == 1 && rode[0].kind == .elevator, "a ride with no tracked height change is an elevator")
  check(abs(rode[0].metres + 7.2) < 0.2, "down 7.2 m, got \(rode.first?.metres ?? 0)")
  check(rode[0].summary == "Down 7.2 m by elevator", "summary reads \(rode[0].summary)")

  // Tracking that drops out as the walker reaches the landing cannot vouch for a height,
  // so a climb is never mislabelled as an elevator ride just because ARKit went quiet.
  let lostOnLanding = floorChanges(stairs) { i in i < 20 ? stairs[i] + 1.4 : nil }
  check(lostOnLanding.count == 1 && lostOnLanding[0].kind == .unknown && lostOnLanding[0].trackedMetres == nil,
    "tracking lost at the landing gives unknown")
  // With tracking lost for the whole climb there is nothing to compare against.
  check(floorChanges(stairs).first?.kind == .unknown, "no tracked height means unknown, not a guess")

  // Up one flight, a pause on the landing, up another: two events, not one of double size.
  let twoFlights = flat(0, 8) + ramp(from: 0, to: 3.5, steps: 10) + flat(3.5, 8)
    + ramp(from: 3.5, to: 7.0, steps: 10) + flat(7.0, 8)
  check(floorChanges(twoFlights).map { ($0.metres * 10).rounded() / 10 } == [3.5, 3.5], "two flights, two events")

  // A door slam or a gust is a spike, then back to the same floor.
  var slam = flat(0, 20)
  slam[9] = 3.0
  check(floorChanges(slam).isEmpty, "a one-sample pressure spike is ignored")

  // A gentle ramp is not a floor change: the height never jumps between settled levels.
  check(floorChanges(ramp(from: 0, to: 1.5, steps: 60)).isEmpty, "a gentle ramp inside one floor is ignored")

  // Careful stairs at 0.12 m/s must not be mistaken for drift and followed away.
  let careful = floorChanges(flat(0, 10) + ramp(from: 0, to: 3.6, steps: 30) + flat(3.6, 12))
  check(careful.count == 1 && abs(careful[0].metres - 3.6) < 0.3, "slow stairs are still one floor, got \(careful.map(\.metres))")
  // Two half-flights with a short pause on the half-landing add up to one floor.
  let halfLanding = floorChanges(
    flat(0, 10) + ramp(from: 0, to: 1.8, steps: 6) + flat(1.8, 4) + ramp(from: 1.8, to: 3.6, steps: 6) + flat(3.6, 12))
  check(halfLanding.count == 1 && abs(halfLanding[0].metres - 3.6) < 0.4, "a half-landing pause does not hide the floor, got \(halfLanding.map(\.metres))")

  // Noisy readings ten times a second settle as readily as once a second.
  var seed: UInt64 = 42
  func noise() -> Double {  // roughly normal, standard deviation 0.2 m
    var total = 0.0
    for _ in 0..<12 {
      seed = seed &* 6364136223846793005 &+ 1442695040888963407
      total += Double(seed >> 33) / Double(1 << 31)
    }
    return (total - 6) * 0.2
  }
  let fastNoisy = (flat(0, 150) + ramp(from: 0, to: 3.6, steps: 120) + flat(3.6, 200)).map { $0 + noise() }
  let fromFast = floorChanges(fastNoisy, rate: 10)
  check(fromFast.count == 1 && abs(fromFast[0].metres - 3.6) < 0.4, "noisy 10 Hz readings give one event, got \(fromFast.map(\.metres))")
  // A phone that reports only every 2.6 s still settles.
  let sparse = floorChanges(flat(0, 5) + ramp(from: 0, to: 3.6, steps: 4) + flat(3.6, 6), rate: 1 / 2.6)
  check(sparse.count == 1, "sparse readings still give the event, got \(sparse.count)")

  // The altimeter stalling for a minute must not connect two unrelated readings.
  var stalled = FloorChangeDetector()
  for i in 0..<6 { _ = stalled.add(AltitudeSample(t: Double(i), altitude: 0, pressureKPa: 101), trackedHeight: nil) }
  check(stalled.add(AltitudeSample(t: 70, altitude: 5, pressureKPa: 101), trackedHeight: nil) == nil,
    "one reading after a gap is not settled")
  // Non-finite readings are dropped.
  check(stalled.add(AltitudeSample(t: 71, altitude: .nan, pressureKPa: 101), trackedHeight: nil) == nil, "NaN altitude")
  // Works at the faster rate some phones report.
  check(floorChanges(flat(0, 60) + ramp(from: 0, to: 4, steps: 80) + flat(4, 60), rate: 10).count == 1,
    "10 Hz readings give the same single event")

  // A section's file holds only its own readings, with the events it is handed, in section time.
  let file = AltitudeFile(
    samples: (0..<30).map { AltitudeSample(t: 100 + Double($0), altitude: Double($0), pressureKPa: 101) },
    floorChanges: climbed, from: 110, to: 125)
  check(file.samples.count == 16 && file.samples[0].t == 0 && file.samples[0].altitude == 10, "samples are cut to the section")
  check(file.floorChanges.count == 1 && file.floorChanges[0].end == climbed[0].end - 110, "events use section time")

  // A floor change is recognised seconds after it ends. If a section closes in that gap,
  // the next section to ask receives it, exactly once.
  var handing = FloorChangeDetector()
  var firstSection = [FloorChange](), secondSection = [FloorChange]()
  for (i, altitude) in stairs.enumerated() {
    _ = handing.add(AltitudeSample(t: 100 + Double(i), altitude: altitude, pressureKPa: 101.3), trackedHeight: nil)
    if i == 23 { firstSection = handing.takeNewEvents() }  // the section closes just after the landing
  }
  secondSection = handing.takeNewEvents()
  check(firstSection.isEmpty && secondSection.count == 1 && handing.takeNewEvents().isEmpty,
    "an event recognised after its section closed is saved once, with the next section")
  let reopened = try JSONDecoder().decode(AltitudeFile.self, from: JSONEncoder().encode(file))
  check(reopened.samples == file.samples && reopened.floorChanges == file.floorChanges && reopened.version == 1, "altitude.json round-trips")

  // Motion blur: focal length x exposure x (turning + sideways speed over distance).
  let focal = 580.0  // a 768-pixel-wide saved photo from a 1920-pixel frame with fx near 1450
  check(MotionBlur.pixels(focalPixels: focal, exposure: 1 / 60.0, turnRate: 0, sidewaysSpeed: 0, depth: 2) == 0, "a still phone does not smear")
  let turning = MotionBlur.pixels(focalPixels: focal, exposure: 1 / 60.0, turnRate: 1.0, sidewaysSpeed: 0, depth: 2)
  check(abs(turning - focal / 60) < 0.001, "turning at 1 rad/s for 1/60 s smears focal/60 pixels")
  let dim = MotionBlur.pixels(focalPixels: focal, exposure: 1 / 30.0, turnRate: 1.0, sidewaysSpeed: 0, depth: 2)
  check(abs(dim - 2 * turning) < 0.001, "a dim corridor doubles the exposure and the smear")
  let near = MotionBlur.pixels(focalPixels: focal, exposure: 1 / 60.0, turnRate: 0, sidewaysSpeed: 1, depth: 1)
  let far = MotionBlur.pixels(focalPixels: focal, exposure: 1 / 60.0, turnRate: 0, sidewaysSpeed: 1, depth: 4)
  check(abs(near - 4 * far) < 0.001, "walking past a near wall smears four times more than one 4 m away")
  check(MotionBlur.pixels(focalPixels: focal, exposure: .nan, turnRate: 1, sidewaysSpeed: 0, depth: 2) == 0, "bad exposure is no estimate")
  check(MotionBlur.pixels(focalPixels: focal, exposure: 0.01, turnRate: 0, sidewaysSpeed: 1, depth: 0).isFinite, "zero depth is clamped")

  // Rates between two camera poses.
  func pose(yaw: Float, at position: SIMD3<Float>) -> simd_float4x4 {
    var m = simd_float4x4(simd_quatf(angle: yaw, axis: SIMD3(0, 1, 0)))
    m.columns.3 = SIMD4(position, 1)
    return m
  }
  let quarterTurn = MotionBlur.rates(from: pose(yaw: 0, at: .zero), to: pose(yaw: .pi / 2, at: .zero), seconds: 0.5)
  check(abs(quarterTurn.turn - .pi) < 0.001 && quarterTurn.sideways < 0.001, "90 degrees in half a second is pi rad/s")
  let forwardStep = MotionBlur.rates(from: pose(yaw: 0, at: .zero), to: pose(yaw: 0, at: SIMD3(0, 0, -0.5)), seconds: 0.5)
  check(forwardStep.turn < 0.001 && forwardStep.sideways < 0.001, "walking straight ahead is not sideways movement")
  let sideStep = MotionBlur.rates(from: pose(yaw: 0, at: .zero), to: pose(yaw: 0, at: SIMD3(0.5, 0, 0)), seconds: 0.5)
  check(abs(sideStep.sideways - 1) < 0.001, "half a metre sideways in half a second is 1 m/s")
  check(MotionBlur.rates(from: pose(yaw: 0, at: .zero), to: pose(yaw: 1, at: .zero), seconds: 0).turn == 0, "no time, no rate")

  // The gate takes a sharp frame at once, waits for one when frames are soft, then relaxes.
  var gate = KeyframeGate()
  check(gate.accept(time: 10, blur: 1), "a sharp frame is taken immediately")
  check(!gate.accept(time: 20.0, blur: 5), "a soft frame is refused while there is patience")
  check(!gate.accept(time: 20.3, blur: 5), "still refused inside the patience window")
  check(gate.accept(time: 20.4, blur: 2.5), "the first sharp frame in the window is taken")
  check(!gate.accept(time: 30.0, blur: 5) && gate.accept(time: 30.7, blur: 5), "after patience runs out a softer frame is allowed")
  check(!gate.accept(time: 40.0, blur: 50) && !gate.accept(time: 41.0, blur: 50) && gate.accept(time: 41.3, blur: 50),
    "after giving up, coverage wins over sharpness")
  // A wait that was abandoned (the photo stopped being due) must not excuse a blurry frame later.
  check(!gate.accept(time: 60, blur: 5), "refused while waiting")
  gate.reset()
  check(!gate.accept(time: 65, blur: 80), "after a reset the wait starts again; an old wait excuses nothing")
  check(gate.accept(time: 50, blur: 3), "the wait restarts after each kept frame")

  // Entrance tag: keep the most certain recent fix and ignore invalid or stale ones.
  let now = Date(timeIntervalSince1970: 1_800_000_000)
  var best = BestFix()
  best.offer(LocationFix(latitude: 43.0, longitude: -81.27, horizontalAccuracy: -1, timestamp: now), now: now)
  best.offer(LocationFix(latitude: 43.0, longitude: -81.27, horizontalAccuracy: 300, timestamp: now), now: now)
  best.offer(LocationFix(latitude: 43.0, longitude: -81.27, horizontalAccuracy: 5, timestamp: now.addingTimeInterval(-60)), now: now)
  check(best.location == nil, "invalid, vague and stale fixes are all refused")
  best.offer(LocationFix(latitude: 43.01, longitude: -81.27, horizontalAccuracy: 40, timestamp: now), now: now)
  best.offer(LocationFix(latitude: 43.02, longitude: -81.27, horizontalAccuracy: 8, timestamp: now), now: now)
  best.offer(LocationFix(latitude: 43.03, longitude: -81.27, horizontalAccuracy: 25, timestamp: now), now: now)
  check(best.location?.latitude == 43.02 && best.location?.horizontalAccuracy == 8, "the most certain fix wins")
  best.offer(HeadingFix(trueHeading: -1, accuracy: 10))
  best.offer(HeadingFix(trueHeading: 120, accuracy: -1))
  check(best.heading == nil, "invalid headings are refused")
  best.offer(HeadingFix(trueHeading: 120, accuracy: 30))
  best.offer(HeadingFix(trueHeading: 118, accuracy: 15))
  check(best.heading == HeadingFix(trueHeading: 118, accuracy: 15), "the most certain heading wins")
  check(!best.tag.isEmpty && EntranceTag().isEmpty, "an empty tag says so")
  let tagData = try JSONEncoder().encode(best.tag)
  let reopenedTag = try JSONDecoder().decode(EntranceTag.self, from: tagData)
  check(reopenedTag == best.tag, "the entrance tag round-trips")

  // Heat: warn from the level where iOS starts throttling.
  check(ThermalLevel(.nominal).warning == nil && ThermalLevel(.fair).warning == nil, "no warning while cool")
  check(ThermalLevel(.serious).warning != nil && ThermalLevel(.critical) > ThermalLevel(.serious), "serious and critical warn, in order")
  check([ThermalLevel.fair, .critical, .nominal].max() == .critical, "the hottest state of a section can be kept")

  print("Sensor rules passed.")
}
