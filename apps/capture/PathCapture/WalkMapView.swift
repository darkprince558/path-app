import SwiftUI
import simd

enum WalkMapStyle { case mini, panel, review }

struct WalkMapView: View {
  let layers: [WalkLayer]
  let style: WalkMapStyle
  var collapse: (() -> Void)?
  private enum Mode { case follow, whole, free }
  @State private var mode: Mode
  @State private var freeCamera: MapCamera?
  @State private var headingUp: Bool
  @Environment(\.verticalSizeClass) private var verticalSize

  init(layers: [WalkLayer], style: WalkMapStyle, collapse: (() -> Void)? = nil) {
    self.layers = layers
    self.style = style
    self.collapse = collapse
    _mode = State(initialValue: style == .review ? .whole : .follow)
    _headingUp = State(initialValue: style != .review)
  }

  private var latest: WalkMap? { layers.last(where: { $0.map.position != nil })?.map }
  private var angle: CGFloat {
    let direction = headingUp ? latest?.heading : layers.lazy.compactMap(\.startDirection).first
    guard let direction else { return 0 }
    return -atan2(CGFloat(direction.x), CGFloat(-direction.y))
  }

  private func camera(for size: CGSize) -> MapCamera {
    if mode == .free, var freeCamera {
      freeCamera.viewport = size
      return freeCamera
    }
    if mode == .whole {
      return .fitting(layers.reduce(CGRect.null) { $0.union($1.bounds) }, rotation: angle, viewport: size)
    }
    return MapCamera(centre: CGPoint(xz: latest?.position ?? .zero),
                     metresPerPoint: max(12 / max(1, size.width), 8 / max(1, size.height)),
                     rotation: angle, viewport: size)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      if style != .mini {
        HStack {
          Text("Walk map").font(.headline)
          Spacer()
          if mode != .follow {
            Button { mode = .follow; freeCamera = nil } label: {
              Image(systemName: "location.fill").frame(width: 44, height: 44)
            }.accessibilityLabel("Recenter")
          }
          Button { mode = .whole; freeCamera = nil } label: {
            Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 44, height: 44)
          }.accessibilityLabel("Whole walk")
          Button {
            headingUp.toggle()
            if mode == .free { freeCamera?.rotation = angle }
          } label: {
            Image(systemName: headingUp ? "location.north.fill" : "location.north.line")
              .frame(width: 44, height: 44)
          }.accessibilityLabel("Map orientation").accessibilityValue(headingUp ? "Heading up" : "Start up")
          if let collapse {
            Button(action: collapse) {
              Image(systemName: "chevron.down").frame(width: 44, height: 44)
            }.accessibilityLabel("Collapse map")
          }
        }.buttonStyle(.borderless)
      }
      GeometryReader { geometry in
        let size = geometry.size
        Canvas { context, _ in draw(context, camera: camera(for: size)) }
          .accessibilityHidden(true)
          .overlay {
            if style != .mini {
              MapGestures(summary: "Walk map, " + String(Int(layers.reduce(0) { $0 + $1.map.distance })) + " metres walked") {
                start, end, zoom, turn in
                var updated = camera(for: size)
                updated.change(from: start, to: end, zoom: zoom, turn: turn)
                freeCamera = updated
                mode = .free
              }
            }
          }
      }
      .frame(height: style == .mini ? 124 : (verticalSize == .compact && style == .panel ? 86 : 190))
      .background(Color(red: 0.06, green: 0.10, blue: 0.13), in: RoundedRectangle(cornerRadius: 9))
      .clipShape(RoundedRectangle(cornerRadius: 9))
      if style != .mini {
        HStack(spacing: 12) {
          Label("Observed", systemImage: "square.fill").foregroundStyle(.mint)
          Label("Walked", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
          Text("Dark = unseen")
        }.font(.caption2)
      }
    }.foregroundStyle(.white).tint(.mint).padding(style == .mini ? 4 : 8)
      .frame(width: style == .mini ? 132 : nil)
      .background(Color(red: 0.09, green: 0.14, blue: 0.17), in: RoundedRectangle(cornerRadius: 14))
  }

  private func draw(_ context: GraphicsContext, camera: MapCamera) {
    let visible = camera.worldBounds
    let tileWidth = CGFloat(WalkMap.tileWidth)
    var hits = Path()
    var routes = Path()
    for layer in layers where layer.bounds.insetBy(dx: -tileWidth, dy: -tileWidth).intersects(visible) {
      for (row, runs) in layer.rows {
        let y = CGFloat(row) * tileWidth
        guard y + tileWidth >= visible.minY, y <= visible.maxY else { continue }
        for rect in runs where visible.intersects(rect) {
          hits.move(to: camera.project(rect.origin))
          hits.addLine(to: camera.project(CGPoint(x: rect.maxX, y: rect.minY)))
          hits.addLine(to: camera.project(CGPoint(x: rect.maxX, y: rect.maxY)))
          hits.addLine(to: camera.project(CGPoint(x: rect.minX, y: rect.maxY)))
          hits.closeSubpath()
        }
      }
      for track in layer.map.tracks {
        guard let first = track.first else { continue }
        routes.move(to: camera.project(CGPoint(xz: first)))
        for p in track.dropFirst() { routes.addLine(to: camera.project(CGPoint(xz: p))) }
      }
    }
    context.fill(hits, with: .color(.mint.opacity(0.65)))
    context.stroke(routes, with: .color(.white), style: StrokeStyle(lineWidth: 2, lineJoin: .round))
    if let start = layers.lazy.compactMap({ $0.map.tracks.first?.first }).first {
      let point = camera.project(CGPoint(xz: start))
      context.stroke(Path(ellipseIn: CGRect(x: point.x - 4, y: point.y - 4, width: 8, height: 8)), with: .color(.white))
    }
    if let latest, let location = latest.position {
      let point = camera.project(CGPoint(xz: location))
      if let heading = latest.heading, latest.tracked {
        var marker = context
        marker.translateBy(x: point.x, y: point.y)
        marker.rotate(by: .radians(Double(camera.rotation) + atan2(Double(heading.x), Double(-heading.y))))
        var arrow = Path()
        arrow.move(to: CGPoint(x: 0, y: -9))
        arrow.addLine(to: CGPoint(x: 6, y: 6))
        arrow.addLine(to: CGPoint(x: 0, y: 3))
        arrow.addLine(to: CGPoint(x: -6, y: 6))
        arrow.closeSubpath()
        marker.fill(arrow, with: .color(.yellow))
      } else {
        context.fill(Path(ellipseIn: CGRect(x: point.x - 4, y: point.y - 4, width: 8, height: 8)), with: .color(.orange))
      }
    }
    let metres = max(1, Int(ceil(30 * camera.metresPerPoint)))
    let bottom = camera.viewport.height - 8
    var bar = Path()
    bar.move(to: CGPoint(x: 8, y: bottom))
    bar.addLine(to: CGPoint(x: 8 + CGFloat(metres) / camera.metresPerPoint, y: bottom))
    context.stroke(bar, with: .color(.white), lineWidth: 2)
    context.draw(Text("\(metres) m").font(.caption2).foregroundColor(.white),
                 at: CGPoint(x: 8, y: bottom - 3), anchor: .bottomLeading)
  }
}
