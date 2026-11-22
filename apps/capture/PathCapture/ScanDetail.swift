import SwiftUI

struct ScanDetail: View {
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
