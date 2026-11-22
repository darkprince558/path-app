import SwiftUI
import VisionKit

/// Pair with the organizer Mac by scanning its recorder QR or pasting its link.
struct PairMac: View {
  @Binding var mac: MacAddress?
  @Environment(\.dismiss) var dismiss
  @State private var entry = ""
  @State private var error = ""
  @State private var camera = false
  private var canScan: Bool {
    DataScannerViewController.isSupported && DataScannerViewController.isAvailable
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          VStack(alignment: .leading, spacing: 12) {
            PairingIllustration()
            Text("Connect to your Mac").font(.display(.title)).foregroundStyle(Brand.text)
            Text("Your Mac turns scans into links that open on any phone nearby.")
              .font(.body).foregroundStyle(Brand.secondaryText)
              .fixedSize(horizontal: false, vertical: true)
            if let host = mac?.origin.host {
              Chip(text: "Connected to " + host, systemImage: "checkmark.circle.fill")
            }
          }

          VStack(alignment: .leading, spacing: 16) {
            NumberedStep(number: 1, text: "On your Mac, open the Path pairing page.")
            NumberedStep(number: 2, text: "Scan its private recorder QR, or paste the organizer link.")
            NumberedStep(
              number: 3, text: "Join the Mac’s Wi-Fi and trust its local certificate in Settings.")
          }
          .card()

          VStack(spacing: 12) {
            if canScan {
              Button {
                camera = true
              } label: {
                Label("Scan recorder QR", systemImage: "qrcode.viewfinder")
              }
              .buttonStyle(.coral)
            }
            VStack(alignment: .leading, spacing: 12) {
              Text(canScan ? "Or paste the link" : "Paste the organizer link")
                .font(.footnote.weight(.semibold)).foregroundStyle(Brand.secondaryText)
              HStack(spacing: 10) {
                Image(systemName: "link").foregroundStyle(Brand.secondaryText)
                SecureField("Organizer link", text: $entry)
                  .textInputAutocapitalization(.never)
                  .autocorrectionDisabled()
                  .submitLabel(.go)
                  .onSubmit { if !entry.isEmpty { connect(entry) } }
                PasteButton(payloadType: String.self) { values in
                  guard let value = values.first else { return }
                  Task { @MainActor in
                    entry = value
                    connect(value)
                  }
                }
                .labelStyle(.iconOnly)
                .buttonBorderShape(.capsule)
                .tint(Brand.primary)
              }
              .padding(.horizontal, 14)
              .frame(minHeight: 50)
              .background(Brand.page, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
              .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Brand.hairline))
              Button("Connect") { connect(entry) }
                .buttonStyle(.brandPrimary)
                .disabled(entry.isEmpty)
              if !error.isEmpty {
                Label(error, systemImage: "exclamationmark.circle")
                  .font(.footnote).foregroundStyle(Brand.accentText)
                  .fixedSize(horizontal: false, vertical: true)
              }
            }
            .card()
          }

          Label(
            "Scanning always works offline. You only need the Mac to publish.",
            systemImage: "wifi.slash"
          )
          .font(.footnote)
          .foregroundStyle(Brand.secondaryText)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 32)
      }
      .scrollDismissesKeyboard(.interactively)
      .background(Brand.page)
      .navigationTitle("Connect to Mac")
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(Brand.page, for: .navigationBar)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
      }
      .sheet(isPresented: $camera) {
        QRReader { value in
          camera = false
          connect(value)
        }
        .ignoresSafeArea()
        .presentationDragIndicator(.visible)
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

private struct NumberedStep: View {
  let number: Int
  let text: String
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 14) {
      Text(number.formatted())
        .font(.data(.footnote, weight: .bold))
        .foregroundStyle(Brand.onPrimary)
        .frame(width: 26, height: 26)
        .background(Brand.primary, in: Circle())
        .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 8 }
      Text(text).font(.body).foregroundStyle(Brand.text)
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
  }
}

/// Phone and laptop joined by a dashed coral route on night.
private struct PairingIllustration: View {
  var body: some View {
    HStack(spacing: 14) {
      Image(systemName: "iphone").font(.system(size: 34, weight: .light))
        .foregroundStyle(Brand.paper)
      Line()
        .stroke(Brand.coral, style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [2, 8]))
        .frame(width: 70, height: 3)
      PinZero().frame(width: 26, height: 26)
      Line()
        .stroke(Brand.coral, style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [2, 8]))
        .frame(width: 70, height: 3)
      Image(systemName: "laptopcomputer").font(.system(size: 34, weight: .light))
        .foregroundStyle(Brand.paper)
    }
    .frame(maxWidth: .infinity)
    .frame(height: 120)
    .background(Brand.night, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    .accessibilityHidden(true)
  }
  private struct Line: Shape {
    func path(in rect: CGRect) -> Path {
      Path { p in
        p.move(to: CGPoint(x: rect.minX, y: rect.midY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
      }
    }
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
