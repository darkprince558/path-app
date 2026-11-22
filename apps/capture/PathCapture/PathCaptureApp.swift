import SwiftUI

@main struct PathCaptureApp: App {
  private let arguments = ProcessInfo.processInfo.arguments

  var body: some Scene {
    WindowGroup {
      if let flag = arguments.firstIndex(of: "-PathCaptureReplay") {
        if let name = arguments.dropFirst(flag + 1).first,
          let url = Bundle.main.url(forResource: name, withExtension: "json"),
          let script = try? ReplayScript(contentsOf: url) {
          ReplayScreen(script: script)
        } else {
          Text("Could not load the requested walk replay.")
        }
      } else {
        LibraryScreen()
      }
    }
  }
}
