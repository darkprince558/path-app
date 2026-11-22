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
      var login = Auth0.webAuth().audience("https://api.not404.app").scope("openid profile email offline_access")
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

  func uploadToken() async throws -> String {
    try await manager.credentials().accessToken
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
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        if let user = account.user {
          VStack(spacing: 14) {
            Avatar(url: user.picture, initial: (user.name ?? user.email ?? "?").prefix(1).uppercased())
            VStack(spacing: 4) {
              Text(user.name ?? user.nickname ?? "Signed in")
                .font(.display(.title2)).foregroundStyle(Brand.text)
              if let email = user.email {
                Text(email).font(.subheadline).foregroundStyle(Brand.secondaryText)
              }
            }
            .multilineTextAlignment(.center)
          }
          .frame(maxWidth: .infinity)
          .padding(.top, 8)

          VStack(alignment: .leading, spacing: 14) {
            if let verified = user.emailVerified {
              Row(label: "Email verified", value: verified ? "Yes" : "No")
            }
            if let nickname = user.nickname { Row(label: "Nickname", value: nickname) }
            VStack(alignment: .leading, spacing: 4) {
              Text("User ID").font(.footnote).foregroundStyle(Brand.secondaryText)
              Text(user.sub).font(.data(.footnote)).foregroundStyle(Brand.text)
                .textSelection(.enabled)
            }
          }
          .card()

          Button("Log Out") { Task { await account.logOut() } }
            .buttonStyle(.quiet)
        } else {
          VStack(alignment: .leading, spacing: 12) {
            ZStack {
              Brand.nightPanel
              PinZero().frame(width: 54, height: 54)
            }
            .frame(height: 130)
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .accessibilityHidden(true)
            Text("Share maps online").font(.display(.title)).foregroundStyle(Brand.text)
            Text(
              "Sign in to upload unlisted maps from this phone. Anyone you send the link to can open them, no app needed."
            )
            .font(.body).foregroundStyle(Brand.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
          }
          VStack(spacing: 12) {
            Button("Log In") { Task { await account.logIn() } }
              .buttonStyle(.coral)
            Button("Sign Up") { Task { await account.logIn(signUp: true) } }
              .buttonStyle(.quiet)
          }
          Label("Scanning works without an account.", systemImage: "info.circle")
            .font(.footnote).foregroundStyle(Brand.secondaryText)
        }
        if account.busy {
          HStack(spacing: 10) {
            ProgressView()
            Text("Connecting to your account").font(.footnote).foregroundStyle(Brand.secondaryText)
          }
        }
        if let message = account.message {
          Label(message, systemImage: "exclamationmark.circle")
            .font(.footnote).foregroundStyle(Brand.accentText)
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 32)
    }
    .background(Brand.page)
    .disabled(account.busy)
    .navigationTitle("Account")
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(Brand.page, for: .navigationBar)
  }

  private struct Row: View {
    let label: String
    let value: String
    var body: some View {
      HStack {
        Text(label).font(.subheadline).foregroundStyle(Brand.secondaryText)
        Spacer()
        Text(value).font(.subheadline.weight(.medium)).foregroundStyle(Brand.text)
      }
      .accessibilityElement(children: .combine)
    }
  }

  private struct Avatar: View {
    let url: URL?
    let initial: String
    var body: some View {
      AsyncImage(url: url) { image in
        image.resizable().scaledToFill()
      } placeholder: {
        Text(initial).font(.display(.title)).foregroundStyle(Brand.onPrimary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Brand.primary)
      }
      .frame(width: 84, height: 84)
      .clipShape(Circle())
      .overlay(Circle().strokeBorder(Brand.coral, lineWidth: 3))
      .accessibilityHidden(true)
    }
  }
}
