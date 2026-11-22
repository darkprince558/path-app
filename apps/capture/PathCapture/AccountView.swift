import Auth0
import SwiftUI

@MainActor
final class CaptureAccount: ObservableObject {
  @Published private(set) var user: UserInfo?
  @Published private(set) var busy = false
  @Published private(set) var message: String?

  private let manager = CredentialsManager(authentication: Auth0.authentication())

  func restore() async {
    await perform {
      do {
        _ = try await manager.credentials()
        readProfile()
      } catch CredentialsManagerError.noCredentials {
        user = nil
      }
    }
  }

  func logIn(signUp: Bool = false) async {
    await perform {
      var login = Auth0.webAuth().scope("openid profile email offline_access")
      if signUp { login = login.parameters(["screen_hint": "signup"]) }
      let credentials = try await login.start()
      // A fresh login can follow a failed renewal for a different account.
      _ = manager.clear()
      guard manager.store(credentials: credentials) else {
        user = nil
        message = "Couldn’t save your session in the Keychain. Please log in again."
        return
      }
      readProfile()
    }
  }

  func logOut() async {
    await perform {
      try await Auth0.webAuth().clearSession()
      guard manager.clear() else {
        message = "Couldn’t remove the session from this device. Please retry logout."
        return
      }
      user = nil
    }
  }

  private func readProfile() {
    user = manager.user
    if user == nil { message = "Couldn’t read your profile. Please log in again." }
  }

  private func perform(_ action: () async throws -> Void) async {
    guard !busy else { return }
    busy = true
    message = nil
    defer { busy = false }
    do {
      try await action()
    } catch WebAuthError.userCancelled {
      return
    } catch {
      message = error.localizedDescription
    }
  }
}

struct AccountView: View {
  @ObservedObject var account: CaptureAccount

  var body: some View {
    List {
      if let user = account.user {
        Section("Profile") {
          if let email = user.email { LabeledContent("Email", value: email) }
          if let verified = user.emailVerified {
            LabeledContent("Email verified", value: verified ? "Yes" : "No")
          }
          if let name = user.name { LabeledContent("Name", value: name) }
          if let nickname = user.nickname { LabeledContent("Nickname", value: nickname) }
          if let picture = user.picture { LabeledContent("Picture", value: picture.absoluteString) }
          LabeledContent("User ID", value: user.sub)
        }
        Button("Log Out") { Task { await account.logOut() } }
      } else {
        Button("Log In") { Task { await account.logIn() } }
        Button("Sign Up") { Task { await account.logIn(signUp: true) } }
      }
      if account.busy { ProgressView("Connecting to your account") }
      if let message = account.message { Text(message).foregroundStyle(.red) }
    }
    .disabled(account.busy)
    .navigationTitle("Account")
  }
}
