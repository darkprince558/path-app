import ImageIO
import SwiftUI

/// Home: start a hallway walk, browse saved walks and scans, reach account and Mac pairing.
struct LibraryScreen: View {
  @StateObject private var scanner = CaptureController()
  @StateObject private var account = CaptureAccount()
  @Environment(\.scenePhase) var phase
  @State private var pairing = false
  @State private var paired = MacAddress.load()
  @State private var pendingDelete: ScanRecord?
  @State private var replay: ReplayScript?
  @State private var showReplay = false
  @AppStorage(EntranceTagger.settingKey) private var tagEntrance = false

  /// One entry per walk (its first saved section) plus standalone scans.
  private var libraryEntries: [ScanRecord] {
    var walks = Set<UUID>()
    return scanner.library.filter { record in
      guard let id = record.walkID else { return true }
      return walks.insert(id).inserted
    }
  }
  private func sections(of record: ScanRecord) -> [ScanRecord] {
    guard let id = record.walkID else { return [record] }
    return scanner.library.filter { $0.walkID == id }
      .sorted { ($0.sectionNumber ?? 0) < ($1.sectionNumber ?? 0) }
  }

  var body: some View {
    Group {
      if scanner.phase == .recording {
        ScanScreen(scanner: scanner) { overlay in
          CameraPreview(session: scanner.session, mesh: scanner.supportsMesh, overlay: overlay)
        }
        .transition(.opacity)
      } else {
        home.transition(.opacity)
      }
    }
    .animation(.easeInOut(duration: 0.3), value: scanner.phase == .recording)
    .sensoryFeedback(trigger: scanner.phase) { _, new in
      switch new {
      case .recording: .start
      case .finished: .success
      default: nil
      }
    }
    .task { await account.restore() }
    .onChange(of: phase) { _, p in
      if p == .background { scanner.stop(reason: "Path Capture went into the background.") }
    }
    .sheet(item: $scanner.selected, onDismiss: { scanner.reload() }) { record in
      if record.walkID != nil {
        WalkReview(records: sections(of: record), paired: $paired, account: account)
      } else {
        ScanDetail(record: record, mac: $paired, account: account)
      }
    }
    .sheet(isPresented: $pairing) { PairMac(mac: $paired) }
  }

  // MARK: Home

  private var home: some View {
    NavigationStack {
      List {
        Section { hero }
          .listRowInsets(EdgeInsets())
          .listRowBackground(Color.clear)

        if scanner.library.isEmpty {
          Section { howItWorks }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }

        if scanner.supported {
          Section {
            Toggle(isOn: $tagEntrance) {
              Label("Tag where this walk starts", systemImage: "location.north.circle")
                .foregroundStyle(Brand.text)
            }
            .tint(Brand.coral)
            .accessibilityIdentifier("tag-entrance-toggle")
            .listRowBackground(Brand.card)
          } footer: {
            Text(
              "Saves one GPS position and compass reading with the walk, so visitors can be pointed to the entrance. Start outdoors: indoors the position can be off by tens of metres. It is never used to place the indoor map. It is saved in the walk's files, so it goes with them when you share a walk."
            )
            .foregroundStyle(Brand.secondaryText)
          }
        }

        Section {
          if scanner.library.isEmpty {
            HStack(spacing: 14) {
              Image(systemName: "tray").font(.title2).foregroundStyle(Brand.secondaryText)
              Text("Finished walks are saved here, even when you’re offline.")
                .font(.subheadline).foregroundStyle(Brand.secondaryText)
            }
            .padding(.vertical, 8)
            .listRowBackground(Brand.card)
          }
          ForEach(libraryEntries) { record in
            Button {
              scanner.selected = record
            } label: {
              ScanRow(record: record, sectionCount: sections(of: record).count)
            }
            .listRowBackground(Brand.card)
            .swipeActions(edge: .trailing) {
              Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = record }
            }
            .contextMenu {
              Button("Delete", systemImage: "trash", role: .destructive) { pendingDelete = record }
            }
          }
        } header: {
          SectionHeading(
            title: "Saved walks",
            detail: libraryEntries.isEmpty ? nil : libraryEntries.count.formatted()
          )
          .textCase(nil)
          .padding(.bottom, 4)
        }

        Section {
          Button { pairing = true } label: { MacRow(mac: paired) }
            .listRowBackground(Brand.card)
        } header: {
          SectionHeading(title: "Mac reconstruction").textCase(nil).padding(.bottom, 4)
        }
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .background(Brand.page)
      .listSectionSpacing(20)
      .navigationTitle("Path Capture")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .principal) {
          HStack(spacing: 8) {
            Wordmark(size: 20)
            Text("Scanner").font(.subheadline.weight(.semibold))
              .foregroundStyle(Brand.secondaryText)
          }
          .accessibilityElement(children: .combine)
          .accessibilityAddTraits(.isHeader)
        }
        ToolbarItem(placement: .topBarTrailing) {
          NavigationLink {
            AccountView(account: account)
          } label: {
            Image(systemName: account.user == nil ? "person.crop.circle" : "person.crop.circle.fill")
              .font(.title3)
              .foregroundStyle(Brand.primary)
          }
          .accessibilityLabel("Account")
          .accessibilityValue(account.user == nil ? "Signed out" : "Signed in")
        }
      }
      .toolbarBackground(Brand.page, for: .navigationBar)
      .navigationDestination(isPresented: $showReplay) {
        if let replay { ReplayScreen(script: replay) }
      }
      .confirmationDialog(
        pendingDelete?.walkID == nil ? "Delete this scan?" : "Delete this walk?",
        isPresented: deleteBinding, titleVisibility: .visible, presenting: pendingDelete
      ) { record in
        Button(record.walkID == nil ? "Delete Scan" : "Delete Walk", role: .destructive) {
          for part in sections(of: record) { try? FileManager.default.removeItem(at: part.folder) }
          scanner.reload()
        }
      } message: { record in
        let count = sections(of: record).count
        Text(
          "\(count == 1 ? "Its 3D model, video and files" : "All \(count) sections") from \(record.title) will be removed from this phone. This can’t be undone."
        )
      }
    }
  }

  private var deleteBinding: Binding<Bool> {
    Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
  }

  private var hero: some View {
    VStack(alignment: .leading, spacing: 14) {
      if scanner.supported {
        Chip(
          text: scanner.mode, systemImage: scanner.supportsMesh ? "cube.transparent" : "camera",
          tint: Brand.sage)
      }
      Text("Map a hallway")
        .font(.display(.largeTitle))
        .foregroundStyle(Brand.paper)
      Text(scanner.instruction)
        .font(.body)
        .foregroundStyle(Brand.sage)
        .fixedSize(horizontal: false, vertical: true)
      Group {
        if !scanner.supported {
          VStack(alignment: .leading, spacing: 12) {
            Label(
              "Live capture needs an iPhone or iPad with ARKit. You can still review and share saved walks.",
              systemImage: "info.circle"
            )
            .font(.footnote)
            .foregroundStyle(Brand.sage)
            #if targetEnvironment(simulator)
            if let url = Bundle.main.url(forResource: "hallway", withExtension: "json"),
              let script = try? ReplayScript(contentsOf: url) {
              Button {
                replay = script
                showReplay = true
              } label: {
                Label("Try a simulated walk", systemImage: "figure.walk")
              }
              .buttonStyle(.coral)
            }
            #endif
          }
        } else if scanner.phase == .saving {
          HStack(spacing: 12) {
            ProgressView().tint(Brand.paper)
            Text("Saving your walk…").font(.headline).foregroundStyle(Brand.paper)
          }
          .frame(maxWidth: .infinity, minHeight: 52)
          .background(Brand.paper.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
        } else {
          Button {
            Task { await scanner.start() }
          } label: {
            Label("Start walk", systemImage: "figure.walk")
          }
          .buttonStyle(.coral)
          .disabled(scanner.phase == .requestingCamera)
        }
      }
      .padding(.top, 6)
    }
    .padding(22)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      ZStack(alignment: .topTrailing) {
        Brand.nightPanel
        ContourRings().frame(width: 260, height: 260).offset(x: 80, y: -70)
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(Brand.hairline))
  }

  private var howItWorks: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("How it works").font(.display(.title3)).foregroundStyle(Brand.text)
        .accessibilityAddTraits(.isHeader)
      Step(
        number: 1, title: "Walk",
        detail:
          "Hold the phone at chest height and walk slowly. The top-down map fills in as you go, and there’s no time limit.")
      Step(
        number: 2, title: "Review",
        detail: "Tap Finish walk, then check the walk map and the 3D sections.")
      Step(
        number: 3, title: "Share",
        detail: "Sign in and upload an unlisted map, or send the whole walk to your Mac to fuse.")
    }
    .card()
  }
}

// MARK: - Pieces

private struct Step: View {
  let number: Int
  let title: String
  let detail: String
  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      Text(number.formatted())
        .font(.data(.subheadline, weight: .bold))
        .foregroundStyle(Brand.ink)
        .frame(width: 30, height: 30)
        .background(Brand.coral, in: Circle())
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.headline).foregroundStyle(Brand.text)
        Text(detail).font(.subheadline).foregroundStyle(Brand.secondaryText)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

/// Faint concentric contour lines, echoing the web's sage contours on night.
private struct ContourRings: View {
  var body: some View {
    ZStack {
      ForEach(0..<6) { i in
        Circle().stroke(Brand.sage.opacity(0.16 - Double(i) * 0.02), lineWidth: 1.2)
          .scaleEffect(0.25 + Double(i) * 0.17)
      }
      PinZero().frame(width: 34, height: 34).opacity(0.9)
    }
    .accessibilityHidden(true)
  }
}

private struct ScanRow: View {
  let record: ScanRecord
  let sectionCount: Int
  var body: some View {
    HStack(spacing: 14) {
      ScanThumbnail(record: record)
      VStack(alignment: .leading, spacing: 4) {
        Text(record.title).font(.headline).foregroundStyle(Brand.text)
        Text(
          record.walkID == nil
            ? "\(record.mode) · \(record.durationText)"
            : "Hallway walk · \(sectionCount) sections"
        )
        .font(.subheadline).foregroundStyle(Brand.secondaryText)
        if record.isShared || record.partial {
          HStack(spacing: 6) {
            if record.isShared { Chip(text: "Link ready", systemImage: "link") }
            if record.partial {
              Chip(
                text: "Interrupted", systemImage: "exclamationmark.triangle", tint: Brand.accentText)
            }
          }
          .padding(.top, 2)
        }
      }
      Spacer(minLength: 0)
      Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
        .foregroundStyle(Brand.secondaryText.opacity(0.6))
    }
    .padding(.vertical, 6)
    .contentShape(Rectangle())
  }
}

/// The scan's first camera photo, or its capture-mode symbol on night.
private struct ScanThumbnail: View {
  let record: ScanRecord
  @State private var image: UIImage?
  var body: some View {
    ZStack {
      Brand.night
      if let image {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        Image(systemName: record.walkID == nil ? record.modeSymbol : "map")
          .font(.title3).foregroundStyle(Brand.sage)
      }
    }
    .frame(width: 60, height: 60)
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    .accessibilityHidden(true)
    .task(id: record.id) {
      let url = record.folder.appendingPathComponent("photo-0.jpg")
      image = await Task.detached(priority: .utility) { Self.thumbnail(url) }.value
    }
  }
  nonisolated private static func thumbnail(_ url: URL) -> UIImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cg = CGImageSourceCreateThumbnailAtIndex(
        source, 0,
        [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceThumbnailMaxPixelSize: 180,
        ] as CFDictionary)
    else { return nil }
    // ARKit camera frames are stored in sensor (landscape) orientation; scans are held upright.
    return UIImage(cgImage: cg, scale: 1, orientation: .right)
  }
}

private struct MacRow: View {
  let mac: MacAddress?
  var body: some View {
    HStack(spacing: 14) {
      Image(systemName: "laptopcomputer.and.iphone")
        .font(.title3)
        .foregroundStyle(mac == nil ? Brand.secondaryText : Brand.onPrimary)
        .frame(width: 44, height: 44)
        .background(
          mac == nil ? Brand.hairline : Brand.primary,
          in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      VStack(alignment: .leading, spacing: 2) {
        Text(mac == nil ? "Connect to Mac" : (mac?.origin.host ?? "Mac"))
          .font(.headline).foregroundStyle(Brand.text)
        Text(
          mac == nil ? "Optional · rebuild camera video, share over Wi-Fi" : "Connected · tap to change"
        )
        .font(.subheadline).foregroundStyle(Brand.secondaryText)
      }
      Spacer(minLength: 0)
      Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
        .foregroundStyle(Brand.secondaryText.opacity(0.6))
    }
    .padding(.vertical, 4)
  }
}
