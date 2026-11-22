import SwiftUI

struct ScanScreen<Source: ScanSource, Camera: View>: View {
  @ObservedObject var scanner: Source
  @ViewBuilder var camera: Camera

  var body: some View {
    ZStack(alignment: .bottom) {
      camera.ignoresSafeArea()
      VStack(alignment: .leading, spacing: 8) {
        WalkMapView(map: scanner.liveMap)
        HStack {
          Label(scanner.tracking.label, systemImage: "viewfinder")
            .foregroundStyle(scanner.tracking == .normal ? Color.primary : Color.orange)
            .accessibilityIdentifier("scan-tracking")
          Spacer()
          Text("\(Int(scanner.liveMap.distance)) m · " + Duration.seconds(scanner.duration).formatted(.time(pattern: .minuteSecond)))
            .accessibilityIdentifier("scan-distance")
        }.font(.subheadline.bold().monospacedDigit())
        Text(scanner.instruction).font(.subheadline)
        HStack {
          VStack(alignment: .leading) {
            Text("Recording section \(scanner.sectionNumber)").font(.subheadline.bold())
            Text("\(scanner.savedSections) saved on phone").font(.caption)
          }
          Spacer()
          Button("Finish walk") { scanner.stop(reason: nil) }.buttonStyle(.borderedProminent)
        }
      }.padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18)).padding()
    }
  }
}
