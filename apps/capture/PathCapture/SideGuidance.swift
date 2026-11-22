import simd
import Foundation

enum RescanSide: String { case left, right }

/// Gravity-aligned 25 cm cells. A far, unobstructed ray can also show that the
/// walker already checked an opening, even when there is no nearby wall.
struct SideObservation {
  typealias Cell = SIMD3<Int32>
  var upright = Set<Cell>()
  var open = Set<Cell>()
  var validPixels = 0

  static func cell(_ point: SIMD3<Float>) -> Cell { Cell(floor(point * 4)) }

  static func sample(width: Int, height: Int, focal: SIMD2<Float>, center: SIMD2<Float>,
                     camera: simd_float4x4, depth: (Int, Int) -> Float?) -> Self {
    var frame = Self()
    func local(_ x: Int, _ y: Int, _ d: Float) -> SIMD3<Float> {
      SIMD3((Float(x) - center.x) * d / focal.x, (center.y - Float(y)) * d / focal.y, -d)
    }
    let origin = camera.columns.3
    for y in stride(from: 2, to: height - 2, by: 8) {
      for x in stride(from: 2, to: width - 2, by: 8) {
        guard let d = depth(x, y), d >= 0.25, d <= 6 else { continue }
        frame.validPixels += 1
        let p = camera * SIMD4(local(x, y, d), 1)
        let delta = SIMD3(p.x - origin.x, p.y - origin.y, p.z - origin.z)
        let horizontal = simd_length(SIMD2(delta.x, delta.z))
        if horizontal > 3.4, abs(delta.y) < horizontal * 0.22 {
          // The ray passed this point before hitting anything.
          let ray = delta * (3 / horizontal)
          frame.open.insert(cell(SIMD3(origin.x, origin.y, origin.z) + ray))
        }
        guard d <= 4, abs(delta.y) < 1.3,
          let l = depth(x-2, y), let r = depth(x+2, y),
          let u = depth(x, y-2), let b = depth(x, y+2),
          [l, r, u, b].allSatisfy({ $0 >= 0.25 && $0 <= 4 && abs($0 - d) < 0.12 })
        else { continue }
        let normal = simd_cross(local(x+2,y,r) - local(x-2,y,l), local(x,y+2,b) - local(x,y-2,u))
        let worldNormal = camera * SIMD4(normal, 0)
        guard simd_length_squared(normal) > 1e-12,
          worldNormal.y * worldNormal.y <= 0.1225 * simd_length_squared(normal) else { continue }
        frame.upright.insert(cell(SIMD3(p.x, p.y, p.z)))
      }
    }
    return frame
  }
}

/// The axes follow translation, so turning the phone to scan a wall does not
/// swap left and right. State belongs to a walk, across recorder sections.
struct SideGuidance {
  private var frames: [(time: Double, observation: SideObservation)] = []
  private var lastPose: (position: SIMD2<Float>, time: Double)?
  private var anchor: SIMD2<Float>?
  private var heading: SIMD2<Float>?
  private var lastMovement = -Double.infinity
  private var travelled: Float = 0
  private var candidate: (side: RescanSide, time: Double, distance: Float)?
  private(set) var cue: RescanSide?

  mutating func update(position: SIMD3<Float>, at time: Double, frame: SideObservation) {
    let here = SIMD2(position.x, position.z)
    if let previous = lastPose {
      let dt = time - previous.time
      if dt <= 0 || dt > 2.5 || simd_distance(previous.position, here) > Float(min(2.6, 0.5 + 2.3 * dt)) {
        self = Self()
      }
    }
    lastPose = (here, time)
    let step = here - (anchor ?? here)
    if anchor == nil { anchor = here }
    if simd_length(step) >= 0.45 {
      let direction = simd_normalize(step)
      if let previous = heading, simd_dot(direction, previous) >= 0.65 {
        heading = simd_normalize(previous * 0.35 + direction * 0.65)
      } else {
        frames.removeAll(keepingCapacity: true)
        candidate = nil
        cue = nil
        heading = direction
      }
      travelled += simd_length(step)
      lastMovement = time
      anchor = here
    }

    frames.removeAll { time - $0.time > 6 }
    guard frame.validPixels >= 6 else {
      frames.removeAll(keepingCapacity: true)
      candidate = nil
      cue = nil
      return
    }
    frames.append((time, frame))
    guard let heading, time - lastMovement <= 5 else {
      candidate = nil
      cue = nil
      return
    }
    let right = SIMD2(-heading.y, heading.x)
    // Count distinct cells seen in at least two independent frames. Looking
    // through a side can clear a cue, but cannot establish the opposite wall.
    var previousUpright = Set<SideObservation.Cell>(), previousOpen = Set<SideObservation.Cell>()
    var wall = SIMD2<Int32>.zero, clear = SIMD2<Int32>.zero
    func side(of cell: SideObservation.Cell, minAcross: Float) -> Int? {
      let p = (SIMD3<Float>(cell) + 0.5) * 0.25 - position
      let offset = SIMD2(p.x, p.z)
      let across = simd_dot(offset, right)
      guard abs(p.y) <= 0.95, abs(simd_dot(offset, heading)) <= 1.25,
        abs(across) >= minAcross, abs(across) <= 3.25 else { return nil }
      return across > 0 ? 1 : 0
    }
    var confirmedWall = Set<SideObservation.Cell>(), confirmedOpen = Set<SideObservation.Cell>()
    for (_, sample) in frames {
      for cell in sample.upright where !confirmedWall.contains(cell) {
        guard let i = side(of: cell, minAcross: 0.4) else { continue }
        if !previousUpright.insert(cell).inserted {
          confirmedWall.insert(cell)
          wall[i] += 1
        }
      }
      for cell in sample.open where !confirmedOpen.contains(cell) {
        guard let i = side(of: cell, minAcross: 2.4) else { continue }
        if !previousOpen.insert(cell).inserted {
          confirmedOpen.insert(cell)
          clear[i] += 1
        }
      }
    }

    func weak(_ i: Int, side: RescanSide) -> Bool {
      wall[i] < (cue == side ? 4 : 2) && clear[i] < 3 && wall[1-i] >= 6
    }
    let side: RescanSide?
    if weak(0, side: .left) { side = .left }
    else if weak(1, side: .right) { side = .right }
    else { side = nil }

    guard let side else { candidate = nil; cue = nil; return }
    if candidate?.side != side { candidate = (side, time, travelled); cue = nil }
    if let candidate, time - candidate.time >= 1.6, travelled - candidate.distance >= 0.9 {
      cue = side
    }
  }
}
