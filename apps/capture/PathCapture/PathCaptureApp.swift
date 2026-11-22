import ARKit
import RealityKit
import SwiftUI
import VisionKit

@main struct PathCaptureApp: App {
  var body: some SwiftUI.Scene { WindowGroup { CaptureScreen() } }
}
private struct CaptureScreen: View {
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
          ZStack(alignment: .bottom) {
            CameraPreview(session: scanner.session, mesh: scanner.supportsMesh).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 8) {
              WalkMapView(map: scanner.liveMap)
              HStack {
                Label(scanner.tracking == "Normal" ? "Tracking" : scanner.tracking, systemImage: "viewfinder")
                  .foregroundStyle(scanner.tracking == "Normal" ? Color.primary : Color.orange)
                Spacer()
                Text("\(Int(scanner.liveMap.distance)) m · " + Duration.seconds(scanner.duration).formatted(.time(pattern: .minuteSecond)))
              }.font(.subheadline.bold().monospacedDigit())
              Text(scanner.instruction).font(.subheadline)
              HStack {
                VStack(alignment: .leading) {
                  Text("Recording section \(scanner.sectionNumber)").font(.subheadline.bold())
                  Text("\(scanner.savedSections) saved on phone").font(.caption)
                }
                Spacer()
                Button("Finish walk") { scanner.stop() }.buttonStyle(.borderedProminent)
              }
            }.padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18)).padding()
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
private struct WalkReview: View {
  let records: [ScanRecord]
  @Binding var paired: MacAddress?
  @Environment(\.dismiss) var dismiss
  @State private var map = WalkMap()
  @State private var section: ScanRecord?
  @State private var archive: URL?
  @State private var working = false
  @State private var message = ""
  var body: some View {
    NavigationStack {
      List {
        Section {
          WalkMapView(map: map, live: false)
          LabeledContent("Tracked distance", value: "\(Int(map.distance.rounded())) m")
          if let reason = records.last?.walkEndReason { Text(reason).foregroundStyle(.orange) }
          if !message.isEmpty { Text(message).font(.footnote) }
        }
        if let first = records.first, records.contains(where: { $0.pointCount > 0 }) {
          Section("Whole walk in 3D") {
            ScanPreview(url: first.folder, walk: records).frame(height: 220).listRowInsets(EdgeInsets())
          }
        }
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
      }.navigationTitle("Walk review").toolbar { Button("Done") { dismiss() } }
    }.task {
      let (combined, missing) = await Task.detached {
        var combined = WalkMap()
        var missing = 0
        for r in records {
          do { combined.include(try WalkMap.read(from: r.folder)) } catch { missing += 1 }
        }
        return (combined, missing)
      }.value
      map = combined
      if missing > 0 { message = "Map data is unavailable for \(missing) section(s)." }
    }.sheet(item: $section) { ScanDetail(record: $0, mac: $paired) }
  }
}
private struct CameraPreview: UIViewRepresentable {
  let session: ARSession
  let mesh: Bool
  func makeUIView(context: Context) -> ARView {
    let v = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
    let scanDelegate = session.delegate
    v.session = session
    session.delegate = scanDelegate
    if mesh {
      v.debugOptions.insert(.showSceneUnderstanding)
    } else {
      v.debugOptions.insert(.showFeaturePoints)
    }
    return v
  }
  func updateUIView(_ view: ARView, context: Context) {}
}
private struct ScanDetail: View {
  @State var record: ScanRecord
  @Binding var mac: MacAddress?
  @Environment(\.dismiss) var dismiss
  @State private var pairing = false
  @State private var busy = false
  @State private var archive: URL?
  @State private var bundleArchive: URL?
  @State private var bundleError = ""
  @State private var retryVideo = false
  @State private var status = ""
  var model: URL { record.folder.appendingPathComponent("scene.glb") }
  var body: some View {
    NavigationStack {
      List {
        if FileManager.default.fileExists(atPath: model.path) {
          Section { ScanPreview(url: model).frame(height: 245).listRowInsets(EdgeInsets()) }
        }
        Section("Capture") {
          LabeledContent("Mode", value: record.mode)
          LabeledContent("Camera poses", value: record.poseCount.formatted())
          LabeledContent("Motion readings", value: record.gyroCount.formatted())
          if record.depthPriority == true {
            Text("Saved points and camera data while an earlier surface was processing. On LiDAR devices the Mac can fuse available depth frames.")
          }
          if record.partial { Text("Interrupted capture · saved through the last frame") }
          if record.triangles > 0 {
            LabeledContent("Surface triangles", value: record.triangles.formatted())
            LabeledContent("Photo-textured", value: record.photoFaces.formatted())
            ForEach(record.classes.keys.sorted(), id: \.self) { k in
              LabeledContent(k.capitalized, value: record.classes[k]!.formatted())
            }
          } else {
            LabeledContent("Measured points", value: record.pointCount.formatted())
          }
        }
        Section("Second-phone viewer") {
          if let u = record.guestURL {
            ShareLink("Share native scan link", item: u)
            Link("Open native scan", destination: u)
          }
          if let u = record.videoGuestURL {
            ShareLink("Share camera reconstruction", item: u)
            Link("Open camera reconstruction", destination: u)
          }
          Button(mac?.origin.host ?? "Connect to Mac") { pairing = true }.disabled(busy)
          if mac != nil {
            if record.guestURL == nil && FileManager.default.fileExists(atPath: model.path) {
              Button("Publish native scan") { run(false) }
            }
            if record.hasVideo && record.videoGuestURL == nil {
              Button(
                retryVideo
                  ? "Retry camera reconstruction"
                  : (record.videoJob == nil
                    ? "Reconstruct camera video on Mac" : "Check camera reconstruction")
              ) { run(true) }
            }
          }
          if busy { ProgressView() }
          if !status.isEmpty { Text(status).font(.footnote) }
        }.disabled(busy)
        if record.triangles > 0 && record.pointCount > 0 {
          Section("LiDAR upload bundle") {
            Text("Device capture ID: " + record.id.uuidString.lowercased()).font(.footnote)
            if let bundleArchive {
              ShareLink("Share LiDAR bundle", item: bundleArchive)
            } else {
              Button("Prepare LiDAR bundle") {
                let scan = record
                busy = true
                bundleError = ""
                Task { @MainActor in
                  defer { busy = false }
                  do {
                    bundleArchive = try await Task.detached { try scan.bundleArchive() }.value
                  } catch { bundleError = error.localizedDescription }
                }
              }.disabled(busy)
            }
            if !bundleError.isEmpty { Text(bundleError).font(.footnote) }
          }
        }
        Section("Files on this phone") {
          if let archive {
            ShareLink("Share complete scan archive", item: archive)
          } else {
            Button("Prepare complete scan archive") {
              busy = true
              let scan = record
              Task { @MainActor in
                defer { busy = false }
                do { archive = try await Task.detached { try scan.archive() }.value } catch {
                  status = error.localizedDescription
                }
              }
            }.disabled(busy)
          }
          ForEach(
            [
              ("3D model", "scene.glb"), ("Colored points", "points.ply"),
              ("Camera video", "camera.mp4"), ("Camera poses and intrinsics", "camera-poses.json"),
              ("Gyro and accelerometer", "motion.json"), ("Scan summary", "scan.json"),
            ], id: \.1
          ) { label, name in
            let url = record.folder.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: url.path) { ShareLink(label, item: url) }
          }
        }
      }.navigationTitle("Scan review").navigationBarTitleDisplayMode(.inline).toolbar {
        Button("Done") { dismiss() }.disabled(busy)
      }.sheet(isPresented: $pairing) { PairMac(mac: $mac) }
    }.interactiveDismissDisabled(busy)
  }
  private func run(_ video: Bool) {
    guard let mac, !busy else { return }
    busy = true
    status = video ? "Checking the camera reconstruction…" : "Sending model to your Mac…"
    Task { @MainActor in
      defer { busy = false }
      do {
        let client = MacClient(mac: mac)
        if !video {
          record.guestURL = try await client.publish(record)
          try record.persist()
          status = "Guest link ready."
          return
        }
        let id = record.videoJob ?? UUID()
        record.videoJob = id
        try record.persist()
        let prefix = "api/captures/" + id.uuidString.lowercased()
        var result: ServerStatus
        do { result = try await client.request(prefix) } catch let error as NSError
          where error.domain == "PathMac" && error.code == 404
        { result = try await client.beginVideo(record, id: id) }
        if result.status == "uploading" || (result.status == "failed" && retryVideo) {
          result = try await client.beginVideo(record, id: id)
        }
        retryVideo = result.status == "failed"
        if let path = result.sharePath {
          record.videoGuestURL = try mac.guest(path)
          try record.persist()
          status = "Guest link ready."
        } else {
          status =
            result.error ?? result.stage
            ?? "Processing on Mac. You can close this screen and check again."
        }
      } catch { status = error.localizedDescription }
    }
  }
}
private struct PairMac: View {
  @Binding var mac: MacAddress?
  @Environment(\.dismiss) var dismiss
  @State private var entry = ""
  @State private var error = ""
  @State private var camera = false
  var body: some View {
    NavigationStack {
      Form {
        Section("Organizer pairing") {
          Text(
            "Open the pairing page on your Mac. Scan its private recorder QR or paste the organizer link here."
          )
          if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
            Button("Scan recorder QR") { camera = true }
          }
          SecureField("Organizer link", text: $entry).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button("Connect") { connect(entry) }.disabled(entry.isEmpty)
          if !error.isEmpty { Text(error).foregroundStyle(.red) }
        }
        Section {
          Text(
            "Scanning works offline. To publish, join the Mac’s Wi-Fi and trust its local certificate in iPhone Settings."
          ).font(.footnote)
        }
      }.navigationTitle("Connect to Mac").toolbar { Button("Close") { dismiss() } }.sheet(
        isPresented: $camera
      ) {
        QRReader { value in
          camera = false
          connect(value)
        }
      }
    }
  }
  func connect(_ value: String) {
    do {
      let a = try MacAddress(value)
      try a.save()
      mac = a
      dismiss()
    } catch { self.error = error.localizedDescription }
  }
}
private struct QRReader: UIViewControllerRepresentable {
  let found: (String) -> Void
  func makeCoordinator() -> Coordinator { Coordinator(found) }
  func makeUIViewController(context: Context) -> DataScannerViewController {
    let c = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
      recognizesMultipleItems: false, isGuidanceEnabled: true, isHighlightingEnabled: true)
    c.delegate = context.coordinator
    do { try c.startScanning() } catch { DispatchQueue.main.async { found("") } }
    return c
  }
  func updateUIViewController(_ ui: DataScannerViewController, context: Context) {}
  static func dismantleUIViewController(_ ui: DataScannerViewController, coordinator: Coordinator) {
    ui.stopScanning()
  }
  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    let found: (String) -> Void
    private var scanned = false
    init(_ f: @escaping (String) -> Void) { found = f }
    func dataScanner(
      _ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem],
      allItems: [RecognizedItem]
    ) {
      guard !scanned else { return }
      for case .barcode(let code) in addedItems {
        if let value = code.payloadStringValue {
          scanned = true
          scanner.stopScanning()
          found(value)
          return
        }
      }
    }
  }
}
