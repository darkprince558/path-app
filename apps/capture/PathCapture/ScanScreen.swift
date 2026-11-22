import SwiftUI
import UIKit

enum ScanLayout: String { case camera, mini, map }

/// The recording screen: camera, the live top-down walk map, one instruction, and the walk HUD.
struct ScanScreen<Source: ScanSource, Camera: View>: View {
  @ObservedObject var scanner: Source
  @ViewBuilder var camera: (Bool) -> Camera
  @AppStorage("scan.layout") private var layout = ScanLayout.mini
  @AppStorage("scan.overlay") private var overlay = true
  @State private var expandedHUD = false
  @State private var showInstruction = true

  var body: some View {
    ZStack {
      Brand.night.ignoresSafeArea()
      GeometryReader { viewport in
        // Resizing the same preview preserves the AR session and its delegate.
        camera(overlay)
          .frame(width: layout == .map ? 86 : viewport.size.width,
                 height: layout == .map ? 44 : viewport.size.height)
          .clipShape(RoundedRectangle(cornerRadius: layout == .map ? 8 : 0))
          .offset(x: layout == .map ? 12 : 0, y: layout == .map ? 6 : 0)
      }
      LinearGradient(
        colors: [.black.opacity(0.4), .clear, .clear, .black.opacity(0.5)], startPoint: .top,
        endPoint: .bottom
      )
      .ignoresSafeArea()
      .allowsHitTesting(false)

      VStack(alignment: .trailing, spacing: 10) {
        HStack(spacing: 10) {
          TrackingPill(tracking: scanner.tracking)
          Spacer()
          Button { overlay.toggle() } label: {
            Image(systemName: overlay ? "square.3.layers.3d" : "square")
          }.accessibilityLabel("Surface overlay").accessibilityValue(overlay ? "On" : "Off")
            .accessibilityIdentifier("scan-overlay-toggle")
          Button { layout = layout == .camera ? .mini : .camera } label: {
            Image(systemName: layout == .camera ? "map" : "map.fill")
          }.accessibilityLabel(layout == .camera ? "Show mini map" : "Hide map")
            .accessibilityIdentifier("scan-layout-toggle")
        }.buttonStyle(ScannerToolButton())
        if layout == .mini {
          Button { layout = .map } label: {
            WalkMapView(layers: scanner.mapLayers, style: .mini)
          }.buttonStyle(.plain)
            .accessibilityLabel("Expand walk map")
            .accessibilityValue("\(Int(scanner.walkedDistance)) metres walked")
            .accessibilityIdentifier("scan-map")
            .simultaneousGesture(LongPressGesture().onEnded { _ in layout = .camera })
        } else if layout == .map {
          WalkMapView(layers: scanner.mapLayers, style: .panel) {
            layout = .mini
          }
        }
        Spacer(minLength: 4)
        if let side = scanner.rescanSide, scanner.tracking == .normal {
          let message = side == .left ? "Scan your left side" : "Scan your right side"
          Label(message, systemImage: side == .left ? "arrow.left" : "arrow.right")
            .font(.headline).foregroundStyle(Brand.ink)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(Brand.coral, in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(message))
            .accessibilityIdentifier("scan-rescan-side")
            .frame(maxWidth: .infinity, alignment: side == .left ? .leading : .trailing)
        } else if showInstruction || scanner.tracking != .normal || expandedHUD {
          Text(scanner.instruction).font(.subheadline.weight(.medium))
            .foregroundStyle(.white)
            .lineLimit(expandedHUD ? nil : 2)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .frame(maxWidth: .infinity, alignment: .leading)
            .transition(.opacity)
        }
        hud
      }
      .padding(.horizontal, 14).padding(.vertical, 6)
      .animation(.easeInOut(duration: 0.25), value: showInstruction)
    }
    .environment(\.colorScheme, .dark)
    .persistentSystemOverlays(.hidden)
    .task(id: scanner.instruction) {
      showInstruction = true
      do { try await Task.sleep(for: .seconds(4)) } catch { return }
      showInstruction = false
    }
    .onChange(of: scanner.tracking) { old, new in
      if old == .normal && new != .normal {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
      }
    }
  }

  private var hud: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .center) {
        VStack(alignment: .leading, spacing: 2) {
          Text("\(Int(scanner.walkedDistance)) m · "
               + Duration.seconds(scanner.duration).formatted(.time(pattern: .minuteSecond)))
            .font(.data(.title3, weight: .semibold)).foregroundStyle(.white)
            .monospacedDigit()
            .accessibilityIdentifier("scan-distance")
          Button { expandedHUD.toggle() } label: {
            Label("Section \(scanner.sectionNumber) · \(scanner.savedSections) saved",
                  systemImage: expandedHUD ? "chevron.down" : "chevron.up")
              .font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.75))
              .frame(minHeight: 32)
          }.buttonStyle(.plain).accessibilityHint("Show or hide recording details")
        }
        Spacer()
        Button { scanner.stop(reason: nil) } label: {
          HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 3, style: .continuous).fill(Brand.ink)
              .frame(width: 12, height: 12)
            Text("Finish walk")
          }
        }
        .buttonStyle(BrandButtonStyle(kind: .coral, fullWidth: false))
        .accessibilityLabel("Finish walk")
      }
      if expandedHUD {
        VStack(alignment: .leading, spacing: 4) {
          Text("Recording section \(scanner.sectionNumber)").font(.headline).foregroundStyle(.white)
          Text(
            "\(scanner.savedSections) saved on phone. A new section starts about every 35 seconds, and the walk keeps going until you finish it."
          )
          .font(.caption).foregroundStyle(.white.opacity(0.75))
          .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 12)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .animation(.easeInOut(duration: 0.2), value: expandedHUD)
    .accessibilityElement(children: .contain).accessibilityIdentifier("scan-hud")
    .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { drag in
      if abs(drag.translation.height) > abs(drag.translation.width) {
        expandedHUD = drag.translation.height < 0
      }
    })
  }
}

private struct TrackingPill: View {
  let tracking: TrackingQuality
  private var color: Color {
    switch tracking {
    case .normal: Color(hex: 0x7BD69A)
    case .limited, .unavailable: Brand.coral
    default: .white.opacity(0.6)
    }
  }
  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: tracking == .normal ? "location.fill" : "exclamationmark.triangle.fill")
        .font(.caption)
        .foregroundStyle(color)
      Text(tracking.label).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
    }
    .padding(.horizontal, 14)
    .frame(height: 44)
    .background(.ultraThinMaterial, in: Capsule())
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("scan-tracking")
    .animation(.easeInOut, value: tracking)
  }
}

private struct ScannerToolButton: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.headline).foregroundStyle(.white).frame(width: 44, height: 44)
      .background(.ultraThinMaterial, in: Circle()).opacity(configuration.isPressed ? 0.65 : 1)
  }
}
