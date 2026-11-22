import Foundation
import simd

/// Centre in ARKit X/Z metres. Screen angles increase clockwise.
struct MapCamera {
  var centre: CGPoint
  var metresPerPoint: CGFloat
  var rotation: CGFloat
  var viewport: CGSize

  private func rotated(_ point: CGPoint, by angle: CGFloat) -> CGPoint {
    CGPoint(x: point.x * cos(angle) - point.y * sin(angle),
            y: point.x * sin(angle) + point.y * cos(angle))
  }

  func project(_ world: CGPoint) -> CGPoint {
    let offset = rotated(CGPoint(x: world.x - centre.x, y: world.y - centre.y), by: rotation)
    return CGPoint(x: viewport.width / 2 + offset.x / metresPerPoint,
                   y: viewport.height / 2 + offset.y / metresPerPoint)
  }

  func unproject(_ point: CGPoint) -> CGPoint {
    let offset = rotated(CGPoint(x: (point.x - viewport.width / 2) * metresPerPoint,
                                 y: (point.y - viewport.height / 2) * metresPerPoint), by: -rotation)
    return CGPoint(x: centre.x + offset.x, y: centre.y + offset.y)
  }

  mutating func change(from start: CGPoint, to end: CGPoint, zoom: CGFloat, turn: CGFloat) {
    guard zoom.isFinite, zoom > 0, turn.isFinite, viewport.width > 0 else { return }
    let anchor = unproject(start)
    rotation = (rotation + turn).remainder(dividingBy: 2 * .pi)
    if zoom != 1 {
      metresPerPoint = min(200 / viewport.width, max(2 / viewport.width, metresPerPoint / zoom))
    }
    let moved = unproject(end)
    centre.x += anchor.x - moved.x
    centre.y += anchor.y - moved.y
  }

  static func fitting(_ bounds: CGRect, rotation: CGFloat, viewport: CGSize) -> Self {
    let rect = bounds.isNull ? CGRect(x: -1.5, y: -1.5, width: 3, height: 3) : bounds
    let width = abs(cos(rotation)) * rect.width + abs(sin(rotation)) * rect.height
    let height = abs(sin(rotation)) * rect.width + abs(cos(rotation)) * rect.height
    return Self(centre: CGPoint(x: rect.midX, y: rect.midY),
                metresPerPoint: max(max(3, width) / max(1, viewport.width - 24),
                                    max(3, height) / max(1, viewport.height - 24)),
                rotation: rotation, viewport: viewport)
  }

  var worldBounds: CGRect {
    let corners = [CGPoint.zero, CGPoint(x: viewport.width, y: 0),
                   CGPoint(x: viewport.width, y: viewport.height), CGPoint(x: 0, y: viewport.height)]
    return corners.map(unproject).reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: .zero)) }
  }
}

extension CGPoint {
  init(xz: SIMD2<Float>) { self.init(x: CGFloat(xz.x), y: CGFloat(xz.y)) }
}

/// Freeze the drawing for a completed section. Adjacent cells form one horizontal run.
struct WalkLayer {
  let map: WalkMap
  let rows: [Int32: [CGRect]]
  let bounds: CGRect
  let startDirection: SIMD2<Float>?

  init(_ map: WalkMap) {
    self.map = map
    let tile = CGFloat(WalkMap.tileWidth)
    var rows = [Int32: [CGRect]]()
    var bounds = CGRect.null
    for (row, cells) in Dictionary(grouping: map.tiles, by: { $0.y }) {
      let columns = cells.map(\.x).sorted()
      var runs = [CGRect]()
      var index = 0
      while index < columns.count {
        let first = columns[index]
        var last = first
        index += 1
        while index < columns.count && Int64(columns[index]) == Int64(last) + 1 {
          last = columns[index]
          index += 1
        }
        let rect = CGRect(x: CGFloat(first) * tile, y: CGFloat(row) * tile,
                          width: (CGFloat(last) - CGFloat(first) + 1) * tile, height: tile)
        runs.append(rect)
        bounds = bounds.union(rect)
      }
      rows[row] = runs
    }
    var startDirection: SIMD2<Float>?
    for track in map.tracks {
      for point in track { bounds = bounds.union(CGRect(origin: CGPoint(xz: point), size: .zero)) }
      if startDirection == nil, track.count >= 2 { startDirection = track[1] - track[0] }
    }
    self.startDirection = startDirection
    self.bounds = bounds
    self.rows = rows
  }
}
