import VisionKit
import SwiftUI

struct PairMac: View {
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
