import SwiftUI

struct ReplayScreen: View {
  @StateObject private var source: ReplaySource
  @State private var review = false

  init(script: ReplayScript) {
    _source = StateObject(wrappedValue: ReplaySource(script: script))
  }

  var body: some View {
    NavigationStack {
      if source.phase == .recording {
        ScanScreen(scanner: source) { _ in Color(white: 0.08) }
          .navigationTitle("Scanning").navigationBarTitleDisplayMode(.inline)
          .task {
            let started = ProcessInfo.processInfo.systemUptime
            while !Task.isCancelled && source.duration < Double(source.script.duration) {
              do { try await Task.sleep(for: .milliseconds(400)) } catch { return }
              source.advance(to: Int((ProcessInfo.processInfo.systemUptime - started) * 4))
            }
          }
      } else {
        Button("Review simulated walk") { review = true }
      }
    }
    .onChange(of: source.phase) { _, phase in review = phase == .finished }
    .sheet(isPresented: $review) {
      WalkReview(records: [], paired: .constant(nil), replayMap: source.liveMap)
    }
  }
}
