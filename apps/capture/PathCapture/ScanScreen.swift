import SwiftUI
import UIKit

enum ScanLayout: String { case camera, mini, map }

struct ScanScreen<Source: ScanSource, Camera: View>: View {
  @ObservedObject var scanner: Source
  @ViewBuilder var camera: (Bool) -> Camera
  @AppStorage("scan.layout") private var layout = ScanLayout.mini
  @AppStorage("scan.overlay") private var overlay = true
  @State private var expandedHUD = false
  @State private var showInstruction = true

  var body: some View {
    ZStack {
      camera(overlay).ignoresSafeArea()
      VStack(alignment: .trailing, spacing: 8) {
        HStack {
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
            WalkMapView(map: scanner.liveMap, style: .mini)
          }.buttonStyle(.plain)
            .accessibilityLabel("Expand walk map")
            .accessibilityValue("\(Int(scanner.liveMap.distance)) metres walked")
            .accessibilityIdentifier("scan-map")
            .simultaneousGesture(LongPressGesture().onEnded { _ in layout = .camera })
        } else if layout == .map {
          WalkMapView(map: scanner.liveMap, style: .panel) {
            layout = .mini
          }.accessibilityIdentifier("scan-map")
        }
        Spacer(minLength: 4)
        if showInstruction || scanner.tracking != .normal || expandedHUD {
          Text(scanner.instruction).font(.subheadline)
            .lineLimit(expandedHUD ? nil : 1)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(.regularMaterial, in: Capsule())
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        VStack(alignment: .leading, spacing: 4) {
          HStack {
            Label(scanner.tracking.label, systemImage: scanner.tracking == .normal ? "location.fill" : "exclamationmark.triangle.fill")
              .font(.subheadline.bold())
              .foregroundStyle(scanner.tracking == .normal ? Color.primary : .orange)
              .accessibilityIdentifier("scan-tracking")
            Spacer()
            Text("\(Int(scanner.liveMap.distance)) m · " + Duration.seconds(scanner.duration).formatted(.time(pattern: .minuteSecond)))
              .font(.subheadline.monospacedDigit()).accessibilityIdentifier("scan-distance")
          }
          HStack {
            Button { expandedHUD.toggle() } label: {
              Label("Section \(scanner.sectionNumber) · \(scanner.savedSections) saved",
                    systemImage: expandedHUD ? "chevron.down" : "chevron.up")
                .font(.caption.bold()).frame(minHeight: 44)
            }.buttonStyle(.plain).accessibilityHint("Show or hide recording details")
            Spacer()
            Button("Finish walk") { scanner.stop(reason: nil) }
              .buttonStyle(.borderedProminent)
          }
          if expandedHUD {
            Text("Recording section \(scanner.sectionNumber)").font(.headline)
            Text("\(scanner.savedSections) saved on phone").font(.caption)
          }
        }.padding(.horizontal, 12).padding(.vertical, 8)
          .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
          .accessibilityElement(children: .contain).accessibilityIdentifier("scan-hud")
          .simultaneousGesture(DragGesture(minimumDistance: 24).onEnded { drag in
            if abs(drag.translation.height) > abs(drag.translation.width) {
              expandedHUD = drag.translation.height < 0
            }
          })
      }.padding(.horizontal, 12).padding(.vertical, 6)
    }
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
}

private struct ScannerToolButton: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.headline).frame(width: 44, height: 44)
      .background(.regularMaterial, in: Circle()).opacity(configuration.isPressed ? 0.65 : 1)
  }
}
