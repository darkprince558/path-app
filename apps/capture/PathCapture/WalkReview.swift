import SwiftUI

/// Review a hallway walk: the top-down map, sensor notes, the 3D overview, and its sections.
struct WalkReview: View {
  let records: [ScanRecord]
  @Binding var paired: MacAddress?
  @ObservedObject var account: CaptureAccount
  var replayMap: WalkMap? = nil
  @Environment(\.dismiss) var dismiss
  @State private var layer = WalkLayer(WalkMap())
  @State private var section: ScanRecord?
  @State private var archive: URL?
  @State private var working = false
  @State private var message = ""

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          mapCard
          if !records.isEmpty { sensorsCard }
          if !records.isEmpty { sectionsCard }
          if let first = records.first, records.contains(where: { $0.pointCount > 0 }) {
            VStack(alignment: .leading, spacing: 12) {
              SectionHeading(title: "Whole walk in 3D")
              ScanPreview(url: first.folder, walk: records)
                .frame(height: 240)
                .background(Brand.night)
                .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                .overlay(
                  RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(Brand.hairline))
            }
          }
          if !records.isEmpty { macCard }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 40)
      }
      .background(Brand.page)
      .navigationTitle("Walk review")
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(Brand.page, for: .navigationBar)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }.fontWeight(.semibold)
        }
      }
    }
    .task {
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
    }
    .sheet(item: $section) { ScanDetail(record: $0, mac: $paired, account: account) }
  }

  // MARK: Cards

  private var mapCard: some View {
    VStack(alignment: .leading, spacing: 14) {
      WalkMapView(layers: [layer], style: .review)
      HStack(spacing: 12) {
        StatBlock(label: "Tracked distance", value: "\(Int(layer.map.distance.rounded())) m")
        if !records.isEmpty {
          StatBlock(label: "Sections", value: records.count.formatted())
          StatBlock(
            label: "Duration",
            value: Duration.seconds(records.reduce(0) { $0 + $1.duration }.rounded())
              .formatted(.time(pattern: .minuteSecond)))
        }
      }
      if let reason = records.last?.walkEndReason {
        Label(reason, systemImage: "exclamationmark.triangle.fill")
          .font(.subheadline).foregroundStyle(Brand.accentText)
          .fixedSize(horizontal: false, vertical: true)
      }
      if !message.isEmpty {
        Label(message, systemImage: "info.circle")
          .font(.footnote).foregroundStyle(Brand.secondaryText)
      }
    }
  }

  private var sensorsCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeading(title: "Sensors")
      VStack(alignment: .leading, spacing: 14) {
        let changes = records.flatMap { record in
          (record.floorChanges ?? []).map { (section: record.sectionNumber ?? 1, change: $0) }
        }
        SensorRow(symbol: "barometer", title: "Floor changes") {
          if records.allSatisfy({ $0.floorChanges == nil }) {
            Text(
              "No barometer readings were saved with this walk. If this phone has a barometer, check Motion & Fitness access in Settings."
            )
          } else if changes.isEmpty {
            Text("No floor changes noticed.")
          } else {
            ForEach(Array(changes.enumerated()), id: \.offset) { _, entry in
              HStack {
                Text(entry.change.summary).foregroundStyle(Brand.text)
                Spacer()
                Text("Section \(entry.section)").font(.data(.footnote))
              }
            }
          }
        }
        if let place = records.compactMap(\.entrance).first {
          Divider().overlay(Brand.hairline)
          SensorRow(symbol: "location.north.circle", title: "Entrance") {
            if let fix = place.location {
              Text(
                String(
                  format: "%.5f, %.5f (within %.0f m)", fix.latitude, fix.longitude,
                  fix.horizontalAccuracy)
              )
              .font(.data(.footnote)).textSelection(.enabled)
            }
            if let heading = place.heading {
              Text(
                String(
                  format: "Facing about %.0f° from north (within %.0f°)", heading.trueHeading,
                  heading.accuracy))
            }
          }
        }
        if let hottest = records.compactMap(\.thermal).max(), let warning = hottest.warning {
          Divider().overlay(Brand.hairline)
          SensorRow(symbol: "thermometer.high", title: "Phone ran hot") {
            Text(
              "Thermal state reached \(hottest.rawValue). Heat can cost frames and tracking. "
                + warning
            )
            .foregroundStyle(Brand.accentText)
          }
        }
      }
      .card()
    }
  }

  private var sectionsCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeading(title: "3D sections", detail: records.count.formatted())
      VStack(spacing: 0) {
        ForEach(Array(records.enumerated()), id: \.element.id) { index, r in
          if index > 0 { Divider().overlay(Brand.hairline).padding(.leading, 52) }
          Button {
            do {
              section = try JSONDecoder().decode(
                ScanRecord.self, from: Data(contentsOf: r.folder.appendingPathComponent("scan.json")))
            } catch { message = "Could not open this section: " + error.localizedDescription }
          } label: {
            HStack(spacing: 14) {
              Text((r.sectionNumber ?? 1).formatted())
                .font(.data(.subheadline, weight: .bold))
                .foregroundStyle(Brand.onPrimary)
                .frame(width: 32, height: 32)
                .background(Brand.primary, in: Circle())
              VStack(alignment: .leading, spacing: 2) {
                Text("Section \(r.sectionNumber ?? 1)").font(.headline).foregroundStyle(Brand.text)
                Text(r.partial ? "Partial" : "\(Int(r.duration.rounded())) s")
                  .font(.subheadline).foregroundStyle(Brand.secondaryText)
              }
              Spacer()
              if r.isShared { Chip(text: "Link ready", systemImage: "link") }
              Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
                .foregroundStyle(Brand.secondaryText.opacity(0.6))
            }
            .padding(.vertical, 10)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
        Label("Open a section to upload it as an unlisted map.", systemImage: "icloud.and.arrow.up")
          .font(.footnote).foregroundStyle(Brand.secondaryText)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.top, 10)
      }
      .card(padding: 16)
    }
  }

  private var macCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeading(title: "Fuse on your Mac")
      VStack(alignment: .leading, spacing: 14) {
        Text("Send every section to your Mac to build one coloured 3D surface for the whole hallway.")
          .font(.subheadline).foregroundStyle(Brand.secondaryText)
          .fixedSize(horizontal: false, vertical: true)
        if let archive {
          ShareLink("Share whole walk", item: archive).buttonStyle(.coral)
        } else {
          Button("Prepare whole walk for Mac") {
            working = true
            Task {
              defer { working = false }
              do { archive = try await Task.detached { try WalkArchive.prepare(records) }.value } catch {
                message = error.localizedDescription
              }
            }
          }
          .buttonStyle(.brandPrimary)
          .disabled(working)
        }
        if working {
          HStack(spacing: 10) {
            ProgressView()
            Text("Preparing archive").font(.footnote).foregroundStyle(Brand.secondaryText)
          }
        }
      }
      .card()
    }
  }
}

// MARK: - Pieces

private struct StatBlock: View {
  let label: String
  let value: String
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label).font(.footnote).foregroundStyle(Brand.secondaryText)
        .lineLimit(1).minimumScaleFactor(0.75)
      Text(value).font(.data(.title3, weight: .semibold)).foregroundStyle(Brand.text)
        .lineLimit(1).minimumScaleFactor(0.7)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14)
    .background(Brand.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Brand.hairline))
  }
}

private struct SensorRow<Content: View>: View {
  let symbol: String
  let title: String
  @ViewBuilder let content: () -> Content
  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: symbol).font(.title3).foregroundStyle(Brand.primary).frame(width: 28)
      VStack(alignment: .leading, spacing: 6) {
        Text(title).font(.headline).foregroundStyle(Brand.text)
        content()
          .font(.subheadline)
          .foregroundStyle(Brand.secondaryText)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}
