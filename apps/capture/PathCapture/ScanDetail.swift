import CoreImage.CIFilterBuiltins
import SwiftUI

/// Review a saved scan: look at the model, share it to a second phone, export files.
struct ScanDetail: View {
  @State var record: ScanRecord
  @Binding var mac: MacAddress?
  @ObservedObject var account: CaptureAccount
  @Environment(\.dismiss) var dismiss
  @State private var pairing = false
  @State private var busy = false
  @State private var archive: URL?
  @State private var bundleArchive: URL?
  @State private var bundleError = ""
  @State private var archiveError = ""
  @State private var retryVideo = false
  @State private var status = ""
  @State private var hostedStatus = ""
  @State private var hostedNeedsLogin = false
  @State private var shownLink = LinkKind.online
  enum LinkKind: Hashable { case online, scan, video }
  var model: URL { record.folder.appendingPathComponent("scene.glb") }
  private var hasModel: Bool { FileManager.default.fileExists(atPath: model.path) }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          preview
          header
          if record.depthPriority == true {
            Label(
              "Saved points and camera data while an earlier surface was processing. Your Mac can fuse the depth frames.",
              systemImage: "cpu"
            )
            .font(.subheadline).foregroundStyle(Brand.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
          }
          if record.partial {
            Label(
              "Interrupted capture. Saved through the last frame.",
              systemImage: "exclamationmark.triangle.fill"
            )
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Brand.accentText)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
              Brand.coral.opacity(0.14), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
          }
          shareSection
          macSection
          detailsSection
          filesSection
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 40)
      }
      .background(Brand.page)
      .navigationTitle("Scan review")
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(Brand.page, for: .navigationBar)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }.fontWeight(.semibold).disabled(busy)
        }
      }
      .sheet(isPresented: $pairing) { PairMac(mac: $mac) }
    }
    .interactiveDismissDisabled(busy)
  }

  // MARK: Preview and header

  @ViewBuilder private var preview: some View {
    ZStack(alignment: .bottomLeading) {
      if hasModel {
        ScanPreview(url: model)
        Label("Drag to orbit · pinch to zoom", systemImage: "hand.draw")
          .font(.caption.weight(.medium))
          .foregroundStyle(.white.opacity(0.85))
          .padding(.horizontal, 10)
          .padding(.vertical, 6)
          .background(.black.opacity(0.35), in: Capsule())
          .padding(12)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      } else {
        VStack(spacing: 10) {
          Image(systemName: record.modeSymbol).font(.largeTitle).foregroundStyle(Brand.sage)
          Text(record.hasVideo ? "Camera video only" : "No 3D model in this scan")
            .font(.headline).foregroundStyle(Brand.paper)
          if record.hasVideo {
            Text("Reconstruct it on your Mac to get a 3D model.")
              .font(.subheadline).foregroundStyle(Brand.sage)
          }
        }
        .multilineTextAlignment(.center)
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .frame(height: 260)
    .frame(maxWidth: .infinity)
    .background(Brand.night)
    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Brand.hairline))
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(record.title).font(.display(.title)).foregroundStyle(Brand.text)
      HStack(spacing: 8) {
        Chip(text: record.mode, systemImage: record.modeSymbol)
        Chip(text: record.durationText, systemImage: "clock")
        if record.isShared { Chip(text: "Link ready", systemImage: "link") }
      }
    }
  }

  // MARK: Share

  private struct GuestLink: Identifiable {
    let id: LinkKind
    let name: String
    let url: URL
  }
  private var hostedLink: URL? {
    guard let subject = account.user?.sub else { return nil }
    return record.hostedLinks?[subject]
  }
  private var links: [GuestLink] {
    var out: [GuestLink] = []
    if let u = hostedLink { out.append(GuestLink(id: .online, name: "Online map", url: u)) }
    if let u = record.guestURL { out.append(GuestLink(id: .scan, name: "Wi-Fi scan", url: u)) }
    if let u = record.videoGuestURL {
      out.append(GuestLink(id: .video, name: "Camera video", url: u))
    }
    return out
  }

  private var shareSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeading(title: "Open on a second phone")
      VStack(alignment: .leading, spacing: 16) {
        if !links.isEmpty { linkPanel }
        if hasModel && hostedLink == nil {
          if let subject = account.user?.sub, !hostedNeedsLogin {
            let pending = record.pendingHostedUploads?.contains(subject) == true
            Text("Upload an unlisted map, then scan its QR code with the second phone.")
              .font(.subheadline).foregroundStyle(Brand.secondaryText)
              .fixedSize(horizontal: false, vertical: true)
            Button {
              publishHosted(subject: subject, recovering: pending)
            } label: {
              Label(
                pending ? "Check previous upload" : "Upload unlisted map",
                systemImage: pending ? "arrow.clockwise" : "icloud.and.arrow.up")
            }
            .buttonStyle(.coral)
            .disabled(busy || account.busy)
            Label(
              "Anyone with the link can open this model and its embedded textures.",
              systemImage: "eye"
            )
            .font(.footnote).foregroundStyle(Brand.secondaryText)
          } else {
            Text("Sign in to upload an unlisted map that opens on any phone.")
              .font(.subheadline).foregroundStyle(Brand.secondaryText)
              .fixedSize(horizontal: false, vertical: true)
            Button {
              Task {
                await account.logIn()
                hostedNeedsLogin = false
                hostedStatus = account.message ?? ""
              }
            } label: {
              Label("Sign in to upload", systemImage: "person.crop.circle")
            }
            .buttonStyle(.coral)
            .disabled(account.busy || busy)
          }
        } else if !hasModel && links.isEmpty {
          Text("This scan has no 3D model yet. Rebuild the camera video on your Mac below.")
            .font(.subheadline).foregroundStyle(Brand.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
        }
        StatusLine(text: hostedStatus, busy: busy && !hostedStatus.isEmpty && status.isEmpty)
      }
      .card()
    }
  }

  private var macSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeading(title: "Mac reconstruction")
      VStack(alignment: .leading, spacing: 16) {
        if mac == nil {
          Text("Optional. Pair a Mac to rebuild the camera video or share over local Wi-Fi.")
            .font(.subheadline).foregroundStyle(Brand.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
          Button {
            pairing = true
          } label: {
            Label("Connect to Mac", systemImage: "laptopcomputer")
          }
          .buttonStyle(.brandPrimary)
        } else {
          if record.guestURL == nil && hasModel {
            Button {
              run(false)
            } label: {
              Label("Publish 3D scan over Wi-Fi", systemImage: "wifi")
            }
            .buttonStyle(.quiet)
          }
          if record.hasVideo && record.videoGuestURL == nil {
            Button {
              run(true)
            } label: {
              Label(videoButtonTitle, systemImage: videoButtonSymbol)
            }
            .buttonStyle(.quiet)
          }
          if record.guestURL != nil && (!record.hasVideo || record.videoGuestURL != nil) {
            Label("Everything from this scan is published on your Mac.", systemImage: "checkmark.circle")
              .font(.subheadline).foregroundStyle(Brand.secondaryText)
          }
        }
        StatusLine(text: status, busy: busy && !status.isEmpty)
        if let mac {
          Divider().overlay(Brand.hairline)
          HStack(spacing: 10) {
            Image(systemName: "laptopcomputer").foregroundStyle(Brand.secondaryText)
            Text(mac.origin.host ?? "Mac").font(.subheadline).foregroundStyle(Brand.text)
              .lineLimit(1)
            Spacer()
            Button("Change Mac") { pairing = true }.font(.subheadline.weight(.semibold))
          }
        }
      }
      .card()
      .disabled(busy)
    }
  }

  private var videoButtonTitle: String {
    if retryVideo { return "Retry camera reconstruction" }
    return record.videoJob == nil
      ? "Reconstruct camera video on Mac" : "Check camera reconstruction"
  }
  private var videoButtonSymbol: String {
    retryVideo
      ? "arrow.clockwise" : (record.videoJob == nil ? "video.badge.waveform" : "hourglass")
  }

  @ViewBuilder private var linkPanel: some View {
    let current = links.first { $0.id == shownLink } ?? links[0]
    VStack(spacing: 14) {
      if links.count > 1 {
        Picker("Link", selection: $shownLink) {
          ForEach(links) { Text($0.name).tag($0.id) }
        }
        .pickerStyle(.segmented)
      }
      QRCode(text: current.url.absoluteString)
        .frame(width: 180, height: 180)
        .padding(12)
        .background(.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityLabel("QR code for the \(current.name) link")
      Text("Scan with the second phone’s camera")
        .font(.footnote).foregroundStyle(Brand.secondaryText)
      HStack(spacing: 10) {
        ShareLink(item: current.url) {
          Label(
            current.id == .online ? "Share map link" : "Share link",
            systemImage: "square.and.arrow.up")
        }
        .buttonStyle(.coral)
        Link(destination: current.url) { Label("Open", systemImage: "safari") }
          .buttonStyle(BrandButtonStyle(kind: .quiet, fullWidth: false))
      }
    }
    .frame(maxWidth: .infinity)
  }

  // MARK: Details

  private var detailsSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeading(title: "Capture details")
      VStack(alignment: .leading, spacing: 18) {
        // Not lazy: every tile exists for VoiceOver and UI tests even when scrolled away.
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 18) {
          GridRow {
            StatTile(label: "Camera poses", value: record.poseCount)
            StatTile(label: "Motion readings", value: record.gyroCount)
          }
          GridRow {
            if record.triangles > 0 {
              StatTile(label: "Surface triangles", value: record.triangles)
              StatTile(label: "Photo-textured", value: record.photoFaces)
            } else {
              StatTile(label: "Measured points", value: record.pointCount)
            }
          }
        }
        if !record.classes.isEmpty {
          Divider().overlay(Brand.hairline)
          SurfaceBreakdown(classes: record.classes)
        }
      }
      .card()
    }
  }

  // MARK: Files

  private var filesSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeading(title: "Files")
      VStack(alignment: .leading, spacing: 16) {
        if record.triangles > 0 && record.pointCount > 0 {
          FileAction(
            title: "LiDAR upload bundle", detail: "For the web uploader", symbol: "shippingbox"
          ) {
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
              }
              .disabled(busy)
            }
          }
          Text("Device capture ID " + record.id.uuidString.lowercased())
            .font(.data(.caption2)).foregroundStyle(Brand.secondaryText)
            .textSelection(.enabled)
          if !bundleError.isEmpty { ErrorText(bundleError) }
          Divider().overlay(Brand.hairline)
        }
        FileAction(
          title: "Complete scan archive", detail: "Everything recorded, as a .zip",
          symbol: "archivebox"
        ) {
          if let archive {
            ShareLink("Share complete scan archive", item: archive)
          } else {
            Button("Prepare complete scan archive") {
              busy = true
              archiveError = ""
              let scan = record
              Task { @MainActor in
                defer { busy = false }
                do { archive = try await Task.detached { try scan.archive() }.value } catch {
                  archiveError = error.localizedDescription
                }
              }
            }
            .disabled(busy)
          }
        }
        if !archiveError.isEmpty { ErrorText(archiveError) }
        Divider().overlay(Brand.hairline)
        DisclosureGroup {
          VStack(alignment: .leading, spacing: 14) {
            ForEach(
              [
                ("3D model", "scene.glb", "cube"), ("Colored points", "points.ply", "circle.grid.3x3"),
                ("Camera video", "camera.mp4", "video"),
                ("Camera poses and intrinsics", "camera-poses.json", "camera.viewfinder"),
                ("Gyro and accelerometer", "motion.json", "gyroscope"),
                ("Scan summary", "scan.json", "doc.text"),
              ], id: \.1
            ) { label, name, symbol in
              let url = record.folder.appendingPathComponent(name)
              if FileManager.default.fileExists(atPath: url.path) {
                ShareLink(item: url) {
                  HStack {
                    Label(label, systemImage: symbol).foregroundStyle(Brand.text)
                    Spacer()
                    Text(Self.size(of: url)).font(.data(.footnote))
                      .foregroundStyle(Brand.secondaryText)
                    Image(systemName: "square.and.arrow.up").foregroundStyle(Brand.primary)
                  }
                }
                .accessibilityLabel(label)
              }
            }
          }
          .padding(.top, 12)
        } label: {
          Label("Individual files", systemImage: "folder").font(.headline)
            .foregroundStyle(Brand.text)
        }
      }
      .card()
    }
  }

  private static func size(of url: URL) -> String {
    let bytes = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    return Int64(bytes).formatted(.byteCount(style: .file))
  }

  // MARK: Publishing

  private func publishHosted(subject: String, recovering: Bool) {
    guard !busy else { return }
    busy = true
    status = ""
    hostedStatus = recovering ? "Looking for this scan in your maps…" : "Uploading the 3D model…"
    Task { @MainActor in
      defer { busy = false }
      do {
        let api = HostedScanAPI()
        let token: String
        do { token = try await account.uploadToken() } catch { throw HostedScanAPI.Failure.login }
        let link: URL?
        if recovering {
          link = try await api.previousUpload(named: record.hostedMapName, token: token)
        } else {
          try HostedScanAPI.checkSize(of: model)
          // Save the attempt first so reopening this screen can recover a lost response.
          record.pendingHostedUploads = (record.pendingHostedUploads ?? []).union([subject])
          try record.persist()
          link = try await api.upload(file: model, name: record.hostedMapName, token: token)
        }
        if let link {
          var links = record.hostedLinks ?? [:]
          links[subject] = link
          record.hostedLinks = links
          shownLink = .online
          hostedStatus = "Your map link is ready."
        } else {
          hostedStatus = "No matching map was found in your account. You can upload again."
        }
        record.pendingHostedUploads?.remove(subject)
        try record.persist()
      } catch HostedScanAPI.Failure.login {
        if !recovering {
          record.pendingHostedUploads?.remove(subject)
          try? record.persist()
        }
        hostedNeedsLogin = true
        hostedStatus = "Sign in again to authorize this upload."
      } catch {
        hostedStatus = error.localizedDescription
      }
    }
  }

  private func run(_ video: Bool) {
    guard let mac, !busy else { return }
    busy = true
    hostedStatus = ""
    status = video ? "Checking the camera reconstruction…" : "Sending model to your Mac…"
    Task { @MainActor in
      defer { busy = false }
      do {
        let client = MacClient(mac: mac)
        if !video {
          record.guestURL = try await client.publish(record)
          try record.persist()
          shownLink = .scan
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
          shownLink = .video
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

// MARK: - Pieces

private struct StatTile: View {
  let label: String
  let value: Int
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.footnote).foregroundStyle(Brand.secondaryText)
      Text(value.formatted()).font(.data(.title3, weight: .semibold)).foregroundStyle(Brand.text)
        .minimumScaleFactor(0.7).lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Surface classes from ARKit's mesh classification, as proportional bars.
private struct SurfaceBreakdown: View {
  let classes: [String: Int]
  var body: some View {
    let total = max(1, classes.values.reduce(0, +))
    VStack(alignment: .leading, spacing: 10) {
      Text("Surface types").font(.footnote).foregroundStyle(Brand.secondaryText)
      ForEach(classes.sorted { $0.value > $1.value }, id: \.key) { name, count in
        VStack(alignment: .leading, spacing: 4) {
          HStack {
            Text(name.capitalized).font(.subheadline).foregroundStyle(Brand.text)
            Spacer()
            Text(count.formatted()).font(.data(.subheadline)).foregroundStyle(Brand.secondaryText)
          }
          GeometryReader { geo in
            Capsule().fill(Brand.hairline)
              .overlay(alignment: .leading) {
                Capsule().fill(Brand.coral)
                  .frame(width: max(6, geo.size.width * Double(count) / Double(total)))
              }
          }
          .frame(height: 6)
          .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
      }
    }
  }
}

private struct FileAction<Action: View>: View {
  let title: String
  let detail: String
  let symbol: String
  @ViewBuilder let action: () -> Action
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 12) {
        Image(systemName: symbol).font(.title3).foregroundStyle(Brand.primary)
          .frame(width: 28)
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.headline).foregroundStyle(Brand.text)
          Text(detail).font(.subheadline).foregroundStyle(Brand.secondaryText)
        }
      }
      action().buttonStyle(.quiet)
    }
  }
}

/// A progress spinner or info icon next to a status message.
private struct StatusLine: View {
  let text: String
  let busy: Bool
  var body: some View {
    if !text.isEmpty {
      HStack(alignment: .top, spacing: 10) {
        if busy {
          ProgressView()
        } else {
          Image(systemName: "info.circle").foregroundStyle(Brand.secondaryText)
        }
        Text(text).font(.footnote).foregroundStyle(Brand.secondaryText)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

private struct ErrorText: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Label(text, systemImage: "exclamationmark.circle").font(.footnote)
      .foregroundStyle(Brand.accentText)
  }
}

/// A crisp QR code in ink on white, the most reliable pairing for phone cameras.
struct QRCode: View {
  let text: String
  var body: some View {
    if let image = Self.render(text) {
      Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
    } else {
      Image(systemName: "qrcode").resizable().scaledToFit().foregroundStyle(Brand.ink)
    }
  }
  private static let context = CIContext()
  static func render(_ text: String) -> UIImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    let colored = output.applyingFilter(
      "CIFalseColor",
      parameters: [
        "inputColor0": CIColor(red: 0x15 / 255, green: 0x22 / 255, blue: 0x1B / 255),
        "inputColor1": CIColor(red: 1, green: 1, blue: 1),
      ])
    guard let cg = context.createCGImage(colored, from: colored.extent) else { return nil }
    return UIImage(cgImage: cg)
  }
}
