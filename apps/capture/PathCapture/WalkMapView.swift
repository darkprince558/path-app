import SwiftUI
import simd

struct WalkMapView: View {
  let map: WalkMap
  var live = true
  @State private var whole = false
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Label("Walk map", systemImage: "map").font(.headline)
        Spacer()
        if live {
          Button(whole ? "Follow me" : "Show whole walk") { whole.toggle() }
            .buttonStyle(.borderless).font(.caption.bold())
        }
      }
      Canvas { context, size in
        draw(in: context, size: size)
      }
      .frame(height: live ? (whole ? 188 : 120) : 215)
      .background(Color(red: 0.06, green: 0.10, blue: 0.13), in: RoundedRectangle(cornerRadius: 9))
      .clipShape(RoundedRectangle(cornerRadius: 9))
      .accessibilityLabel(
        "Top-down map, \(map.tiles.count) observed tiles, \(Int(map.distance)) metres walked")
      HStack(spacing: 12) {
        Label("Observed", systemImage: "square.fill").foregroundStyle(.mint)
        Label("Walked", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
          .foregroundStyle(.white)
        Text("Dark = unseen").foregroundStyle(.white.opacity(0.75))
      }.font(.caption2)
    }.foregroundStyle(.white).tint(.mint).padding(10)
      .background(Color(red: 0.09, green: 0.14, blue: 0.17), in: RoundedRectangle(cornerRadius: 14))
  }

  private func draw(in context: GraphicsContext, size: CGSize) {
    guard size.width > 24, size.height > 24 else { return }
    let tile = WalkMap.tileWidth
    let overview = whole || !live
    var center = map.position ?? .zero
    var scale = min(size.width / 12, size.height / 8)
    if overview {
      var low = center
      var high = center
      for cell in map.tiles {
        let p = SIMD2<Float>(cell) * tile
        low = simd_min(low, p)
        high = simd_max(high, p + SIMD2(repeating: tile))
      }
      for path in map.tracks {
        for p in path {
          low = simd_min(low, p)
          high = simd_max(high, p)
        }
      }
      center = (low + high) / 2
      scale = min(
        (size.width - 24) / CGFloat(max(3, high.x - low.x)),
        (size.height - 24) / CGFloat(max(3, high.y - low.y)))
    }
    func project(_ p: SIMD2<Float>) -> CGPoint {
      CGPoint(
        x: size.width / 2 + CGFloat(p.x - center.x) * scale,
        y: size.height / 2 + CGFloat(p.y - center.y) * scale)
    }
    let bounds = CGRect(origin: .zero, size: size)
    let cellWidth = CGFloat(tile) * scale
    var hits = Path()
    for cell in map.tiles {
      let origin = project(SIMD2<Float>(cell) * tile)
      let rect = CGRect(
        origin: origin, size: CGSize(width: max(1, cellWidth), height: max(1, cellWidth)))
      if bounds.intersects(rect) { hits.addRect(rect) }
    }
    context.fill(hits, with: .color(.mint.opacity(0.65)))
    for track in map.tracks {
      guard let first = track.first else { continue }
      var line = Path()
      line.move(to: project(first))
      for p in track.dropFirst() { line.addLine(to: project(p)) }
      context.stroke(line, with: .color(.white), style: StrokeStyle(lineWidth: 2, lineJoin: .round))
    }
    if let start = map.tracks.first?.first {
      let p = project(start)
      context.stroke(
        Path(ellipseIn: CGRect(x: p.x - 4, y: p.y - 4, width: 8, height: 8)), with: .color(.white),
        lineWidth: 2)
    }
    if let location = map.position {
      let p = project(location)
      if let heading = map.heading, map.tracked {
        var marker = context
        marker.translateBy(x: p.x, y: p.y)
        marker.rotate(by: .radians(atan2(Double(heading.x), Double(-heading.y))))
        var arrow = Path()
        arrow.move(to: CGPoint(x: 0, y: -9))
        arrow.addLine(to: CGPoint(x: 6, y: 6))
        arrow.addLine(to: CGPoint(x: 0, y: 3))
        arrow.addLine(to: CGPoint(x: -6, y: 6))
        arrow.closeSubpath()
        marker.fill(arrow, with: .color(.yellow))
      } else {
        context.fill(
          Path(ellipseIn: CGRect(x: p.x - 4, y: p.y - 4, width: 8, height: 8)),
          with: .color(.orange))
      }
    }
    let metres = max(1, Int(ceil(30 / scale)))
    var bar = Path()
    bar.move(to: CGPoint(x: 8, y: size.height - 8))
    bar.addLine(to: CGPoint(x: 8 + CGFloat(metres) * scale, y: size.height - 8))
    context.stroke(bar, with: .color(.white), lineWidth: 2)
    context.draw(
      Text("\(metres) m").font(.caption2).foregroundColor(.white),
      at: CGPoint(x: 8, y: size.height - 11), anchor: .bottomLeading)
  }
}
