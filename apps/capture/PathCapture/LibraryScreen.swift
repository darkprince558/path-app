import SwiftUI

struct LibraryScreen: View {
  @StateObject private var scanner = CaptureController()
  @Environment(\.scenePhase) var phase
  @State private var pairing = false
  @State private var paired = MacAddress.load()
  private var libraryEntries: [ScanRecord] {
    var walks = Set<UUID>()
    return scanner.library.filter { record in
      guard let id = record.walkID else { return true }
      return walks.insert(id).inserted
    }
  }
  var body: some View {
    NavigationStack {
      Group {
        if scanner.phase == .recording {
          ScanScreen(scanner: scanner) {
            CameraPreview(session: scanner.session, mesh: scanner.supportsMesh)
          }
        } else {
          List {
            Section {
              VStack(alignment: .leading, spacing: 12) {
                Image(systemName: "viewfinder").font(.largeTitle).foregroundStyle(.green)
                Text("Map a hallway").font(.title.bold())
                Text(scanner.instruction).foregroundStyle(.secondary)
                if scanner.supported {
                  Label(
                    scanner.mode, systemImage: scanner.supportsMesh ? "cube.transparent" : "camera"
                  ).font(.subheadline)
                  Button("Start walk") { Task { await scanner.start() } }.buttonStyle(
                    .borderedProminent
                  ).controlSize(.large).disabled(
                    scanner.phase == .saving || scanner.phase == .requestingCamera)
                } else {
                  Text("Live AR capture requires a compatible iPhone or iPad.").font(.footnote)
                }
                if scanner.phase == .saving { ProgressView("Saving scan") }
              }.padding(.vertical, 6)
            }
            Section("Saved scans") {
              if scanner.library.isEmpty {
                Text("Finished scans appear here, including when you’re offline.").foregroundStyle(
                  .secondary)
              }
              ForEach(libraryEntries) { r in
                Button {
                  scanner.selected = r
                } label: {
                  VStack(alignment: .leading) {
                    Text(r.created.formatted(date: .abbreviated, time: .shortened))
                    Text(r.walkID == nil ? "\(r.mode) · \(Int(r.duration)) seconds" : "Hallway walk · \(scanner.library.filter { $0.walkID == r.walkID }.count) sections").font(.caption).foregroundStyle(
                      .secondary)
                  }
                }
              }
            }
            Section {
              Button {
                pairing = true
              } label: {
                Label(paired?.origin.host ?? "Connect to Mac", systemImage: "desktopcomputer")
              }
            }
          }
        }
      }.navigationTitle(scanner.phase == .recording ? "Scanning" : "Path Capture")
        .navigationBarTitleDisplayMode(.inline)
    }.onChange(of: phase) { _, p in if p == .background { scanner.stop(reason: "Path Capture went into the background.") } }.sheet(
      item: $scanner.selected, onDismiss: { scanner.reload() }
    ) { record in
      if let id = record.walkID {
        WalkReview(records: scanner.library.filter { $0.walkID == id }.sorted { ($0.sectionNumber ?? 0) < ($1.sectionNumber ?? 0) }, paired: $paired)
      } else { ScanDetail(record: record, mac: $paired) }
    }.sheet(isPresented: $pairing) {
      PairMac(mac: $paired)
    }
  }
}
