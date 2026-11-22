import SwiftUI

struct WalkReview: View {
  let records: [ScanRecord]
  @Binding var paired: MacAddress?
  var replayMap: WalkMap? = nil
  @Environment(\.dismiss) var dismiss
  @State private var layer = WalkLayer(WalkMap())
  @State private var section: ScanRecord?
  @State private var archive: URL?
  @State private var working = false
  @State private var message = ""
  var body: some View {
    NavigationStack {
      List {
        Section {
          WalkMapView(layers: [layer], style: .review)
          LabeledContent("Tracked distance", value: "\(Int(layer.map.distance.rounded())) m")
          if let reason = records.last?.walkEndReason { Text(reason).foregroundStyle(.orange) }
          if !message.isEmpty { Text(message).font(.footnote) }
        }
        if let first = records.first, records.contains(where: { $0.pointCount > 0 }) {
          Section("Whole walk in 3D") {
            ScanPreview(url: first.folder, walk: records).frame(height: 220).listRowInsets(EdgeInsets())
          }
        }
        if !records.isEmpty {
          Section("3D sections") {
            ForEach(records) { r in
              Button {
                do {
                  section = try JSONDecoder().decode(ScanRecord.self, from: Data(contentsOf: r.folder.appendingPathComponent("scan.json")))
                } catch { message = "Could not open this section: " + error.localizedDescription }
              } label: {
                HStack {
                  Text("Section \(r.sectionNumber ?? 1)")
                  Spacer()
                  Text(r.partial ? "Partial" : "\(Int(r.duration.rounded())) s").foregroundStyle(.secondary)
                  Image(systemName: "chevron.right")
                }
              }
            }
          }
          Section {
            if let archive {
              ShareLink("Share whole walk", item: archive)
            } else {
              Button("Prepare whole walk for Mac") {
                working = true
                Task {
                  defer { working = false }
                  do { archive = try await Task.detached { try WalkArchive.prepare(records) }.value }
                  catch { message = error.localizedDescription }
                }
              }.disabled(working)
            }
            if working { ProgressView("Preparing archive") }
          }
        }
      }.navigationTitle("Walk review").toolbar { Button("Done") { dismiss() } }
    }.task {
      if let replayMap { layer = WalkLayer(replayMap); return }
      let (combined, missing) = await Task.detached {
        var combined = WalkMap()
        var missing = 0
        for r in records {
          do { combined.include(try WalkMap.read(from: r.folder)) } catch { missing += 1 }
        }
        return (WalkLayer(combined), missing)
      }.value
      layer = combined
      if missing > 0 { message = "Map data is unavailable for \(missing) section(s)." }
    }.sheet(item: $section) { ScanDetail(record: $0, mac: $paired) }
  }
}
