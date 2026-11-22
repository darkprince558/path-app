# Capture and processing

The isolated [LiDAR contract integration](../../docs/lidar-contract-compatibility.md)
adapts the native exporter and [CPU processor](processor/README.md) to the existing
backend contract. Its shared synthetic fixture is `fixtures/lidar-native-capture/`.

Krishna and Anish own the phone capture, export and alignment pipeline. Start by scanning a short corridor with an identifiable turn. Try exporting colored PLY from a LiDAR phone and give Arielle and Sam the resulting format, file size, encoding, axis convention and a known distance. Keep local captures in the ignored `captures-local/` directory at the repository root.

Save several camera frames while recording and label which turn or landmark they show. These are the inputs for Gemini’s directions experiment. For the venue milestone, verify scan-to-event alignment before exporting the routing graph in meters.

[First phone trial and format alternatives](../../docs/scan-formats.md) · [Shared venue example](../../fixtures/README.md)

## iOS scanner sign-in

Open [PathCapture.xcodeproj](PathCapture.xcodeproj) in Xcode. Select **PathCapture**, choose an iPhone simulator, and press **Run**. Xcode resolves Auth0.swift through Swift Package Manager. Recording and reviewing local scans work while signed out.

1. In the [Auth0 Dashboard](https://manage.auth0.com/dashboard/ca/dev-rxl644oh31bf0rhm/applications/nRXF1ROwoRrOMGYGXPyOqfRtJtcxaqCa/settings), open the scanner’s **Native** application. Under **Settings**, append the URI below to both **Allowed Callback URLs** and **Allowed Logout URLs**, then **Save Changes**.

   ```text
   com.not404.scanner://dev-rxl644oh31bf0rhm.ca.auth0.com/ios/com.not404.scanner/callback
   ```

2. In Path Capture, open **Account → Sign Up** or **Log In**. Complete Universal Login and confirm that **Account** displays your email and user ID.
3. Quit the app, relaunch it and reopen **Account**. The SDK restores valid credentials from the Keychain and can renew them when the native application allows the **Refresh Token** grant.
4. Tap **Log Out**, complete the browser prompt, and reopen the app to verify the sign-in buttons return.

The app uses a custom URL scheme with the registered bundle ID `com.not404.scanner`. iOS installs this alongside older `com.pathapp.demo.capture` builds. Scans recorded with the older build are accessible from that installation. [Auth0.swift setup](https://github.com/auth0/Auth0.swift/tree/2.25.0#configure-the-sdk)

## Share a scan directly from the iPhone

Open **Not 404 Scanner**, record a scan and tap **Finish scan**. Scan Review opens automatically. You can also reopen a finished scan from **Saved scans** after reconnecting.

1. In **Share online**, sign in if prompted. The native Auth0 application must be authorized for user-delegated access to the API identifier `https://api.not404.app`. Existing sessions from before this permission can sign in again.
2. Tap **Upload unlisted map**. The app sends the saved `scene.glb` with its embedded textures to `POST https://not404.vodka/api/scans?format=glb&visibility=unlisted&name=…`. The maximum model size is 100 MiB. Recording can be offline. Upload requires Wi-Fi or cellular.
3. Tap **Share map link** or **Open map**. A signed-out visitor can open that URL. The link is also available under the uploader’s account in **My maps** on the website.
4. If the connection drops, reopen the same scan under the same account and tap **Check previous upload**. The app looks up the original scan name in My maps to recover the URL. If you already renamed the map online, copy its link from My maps.

This path publishes the finished model. The separate LiDAR bundle includes the source frames and poses used for CPU processing and landmark-cue generation.
