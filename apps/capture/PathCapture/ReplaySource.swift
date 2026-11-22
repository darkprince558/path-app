import Combine
import Foundation
import simd

struct ReplayScript: Decodable {
  struct Event: Decodable {
    let second: Int
    let velocity: SIMD2<Float>?
    let observationOffset: SIMD3<Float>?
    let quality: TrackingQuality?
    let faces: Int?
  }
  let version: Int
  let duration: Int
  let events: [Event]

  init(contentsOf url: URL) throws {
    self = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
    guard version == 1, (1...3600).contains(duration),
      events.allSatisfy({ (0...duration).contains($0.second) }),
      events.map(\.second) == events.map(\.second).sorted()
    else { throw CocoaError(.fileReadCorruptFile) }
  }
}

/// Uses the same tracked-pose, observation and section-budget rules as the recorder.
final class ReplaySource: ScanSource {
  let script: ReplayScript
  @Published private(set) var phase = ScanPhase.recording
  @Published private(set) var liveMap = WalkMap()
  private(set) var tracking = TrackingQuality.waiting
  private(set) var duration = 0.0
  private(set) var sectionNumber = 1
  private(set) var savedSections = 0
  private var nextSecond = 0
  private var nextEvent = 0
  private var sectionStart = 0
  private var location = SIMD2<Float>.zero
  private var velocity = SIMD2<Float>.zero
  private var observationOffset: SIMD3<Float>?
  private var faces = 0
  private var completed = WalkMap()
  private var section = WalkMap()

  var instruction: String {
    tracking == .normal ? "Walk replay · Follow the hallway around the turn." : "Waiting for tracking to recover."
  }

  init(script: ReplayScript) {
    self.script = script
    advance(to: 0)
  }

  func advance(to second: Int) {
    guard phase == .recording, nextSecond <= min(second, script.duration) else { return }
    for time in nextSecond...min(second, script.duration) {
      if time > 0 { location += velocity }
      while nextEvent < script.events.count, script.events[nextEvent].second == time {
        let event = script.events[nextEvent]
        velocity = event.velocity ?? velocity
        tracking = event.quality ?? tracking
        observationOffset = event.observationOffset ?? observationOffset
        faces = event.faces ?? faces
        nextEvent += 1
      }
      section.locate(location, forward: velocity, at: Double(time), normal: tracking == .normal)
      if section.tracked, let observationOffset {
        section.observe(SIMD3(location.x, 0, location.y) + observationOffset, cameraHeight: 1.5)
      }
      if time < script.duration,
        SectionBudget.shouldSave(seconds: Double(time - sectionStart), points: 0, faces: faces) {
        completed.include(section)
        section = section.nextSection()
        savedSections += 1
        sectionNumber += 1
        sectionStart = time
      }
      duration = Double(time)
      nextSecond = time + 1
    }
    var map = completed
    map.include(section)
    liveMap = map
  }

  func stop(reason: String?) {
    guard phase == .recording else { return }
    savedSections += 1
    phase = .finished
  }
}
