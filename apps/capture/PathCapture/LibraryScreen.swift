import SwiftUI

struct LibraryScreen: View {
  @StateObject private var scanner = CaptureController()
  @Environment(\.scenePhase) var phase
  @State private var pairing = false
  @State private var paired = MacAddress.load()
  @AppStorage(EntranceTagger.settingKey) private var tagEntrance = false
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
          ScanScreen(scanner: scanner) { overlay in
            CameraPreview(session: scanner.session, mesh: scanner.supportsMesh, overlay: overlay)
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
                  #if targetEnvironment(simulator)
                  if let url = Bundle.main.url(forResource: "hallway", withExtension: "json"),
                    let script = try? ReplayScript(contentsOf: url) {
                    NavigationLink("Try a simulated walk") { ReplayScreen(script: script) }
                  }
                  #endif
                }
                if scanner.phase == .saving { ProgressView("Saving scan") }
              }.padding(.vertical, 6)
            }
            if scanner.supported {
              Section {
                Toggle("Tag where this walk starts", isOn: $tagEntrance)
                  .accessibilityIdentifier("tag-entrance-toggle")
              } footer: {
                Text("Saves one GPS position and compass reading with the walk, so visitors can be pointed to the entrance. Start outdoors: indoors the position can be off by tens of metres. It is never used to place the indoor map. It is saved in the walk's files, so it goes with them when you share a walk.")
              }
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
