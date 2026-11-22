import XCTest

final class PathCaptureUITests: XCTestCase {
  func testTrySimulatedWalkFromLibrary() throws {
    let app = XCUIApplication()
    app.launch()
    let replay = app.buttons["Try a simulated walk"]
    XCTAssertTrue(replay.waitForExistence(timeout: 10))
    replay.tap()
    XCTAssertTrue(app.buttons["Finish walk"].waitForExistence(timeout: 5))
    app.buttons["Finish walk"].tap()
    XCTAssertTrue(app.navigationBars["Walk review"].waitForExistence(timeout: 5))
  }

  func testRescanSideAppearsAndClears() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-PathCaptureReplay", "hallway"]
    app.launch()
    let cue = app.descendants(matching: .any)["scan-rescan-side"].firstMatch
    XCTAssertTrue(cue.waitForExistence(timeout: 8))
    XCTAssertEqual(cue.label, "Scan your right side")
    let cleared = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: cue)
    XCTAssertEqual(XCTWaiter.wait(for: [cleared], timeout: 18), .completed)
    XCTAssertTrue(app.buttons["Finish walk"].exists)
  }

  func testScanScreenReplay() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-PathCaptureReplay", "hallway"]
    app.launch()
    XCTAssertTrue(app.buttons["scan-layout-toggle"].waitForExistence(timeout: 10))
    if app.buttons["Collapse map"].exists { app.buttons["Collapse map"].tap() }
    if !app.buttons["scan-map"].exists { app.buttons["scan-layout-toggle"].tap() }
    XCTAssertTrue(app.buttons["scan-map"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any)["scan-tracking"].firstMatch.exists)
    XCTAssertTrue(app.staticTexts["scan-distance"].exists)
    app.buttons["scan-map"].tap()
    XCTAssertTrue(app.buttons["Collapse map"].waitForExistence(timeout: 5))
    let surface = app.descendants(matching: .any)["map-surface"].firstMatch
    XCTAssertTrue(surface.waitForExistence(timeout: 5))
    surface.swipeLeft()
    XCTAssertTrue(app.buttons["Recenter"].waitForExistence(timeout: 5))
    surface.pinch(withScale: 1.6, velocity: 1)
    surface.rotate(0.5, withVelocity: 1)
    app.buttons["Recenter"].tap()
    XCTAssertFalse(app.buttons["Recenter"].exists)
    app.buttons["Whole walk"].tap()
    XCTAssertTrue(app.buttons["Recenter"].exists)
    app.buttons["Collapse map"].tap()
    app.buttons["scan-layout-toggle"].tap()
    XCTAssertFalse(app.buttons["scan-map"].exists)
    app.buttons["scan-overlay-toggle"].tap()
    app.launchArguments = ["-PathCaptureReplay", "hallway"]
    app.terminate()
    app.launch()
    XCTAssertTrue(app.buttons["scan-layout-toggle"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["scan-map"].exists)
    app.buttons["scan-layout-toggle"].tap()
    XCTAssertTrue(app.buttons["scan-map"].exists)
    app.buttons["Finish walk"].tap()
    XCTAssertTrue(app.navigationBars["Walk review"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Tracked distance"].exists)
  }

  func testWholeWalkReview() throws {
    let app = XCUIApplication()
    app.launch()
    let entry = app.buttons.containing(NSPredicate(format:"label CONTAINS %@", "Hallway walk · 2 sections")).firstMatch
    XCTAssertTrue(entry.waitForExistence(timeout: 10))
    entry.tap()
    XCTAssertTrue(app.navigationBars["Walk review"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Walk map"].exists)
    XCTAssertTrue(app.descendants(matching:.any)["native-model-preview"].firstMatch.waitForExistence(timeout: 10))
    let section = app.buttons.containing(NSPredicate(format:"label CONTAINS %@", "Section 2")).firstMatch
    if !section.isHittable { app.swipeUp() }
    section.tap()
    XCTAssertTrue(app.navigationBars["Scan review"].waitForExistence(timeout: 10))
    app.navigationBars["Scan review"].buttons["Done"].tap()
    let prepare = app.buttons["Prepare whole walk for Mac"]
    for _ in 0..<3 where !prepare.isHittable { app.swipeUp() }
    prepare.tap()
    XCTAssertTrue(app.buttons["Share whole walk"].waitForExistence(timeout: 15))
  }
  func testAccountIsAccessibleFromScanner() throws {
    let app = XCUIApplication()
    app.launch()
    app.buttons["Account"].tap()
    XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 5))
    if !app.buttons["Log Out"].exists {
      XCTAssertTrue(app.buttons["Log In"].waitForExistence(timeout: 5))
      XCTAssertTrue(app.buttons["Sign Up"].exists)
    }
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.staticTexts["Scan a space"].waitForExistence(timeout: 5))
  }

  func testOfflineScanReview() throws {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.staticTexts["Map a hallway"].waitForExistence(timeout: 15))
    let fixture = app.buttons.containing(
      NSPredicate(format: "label CONTAINS %@", "Synthetic wall fixture")
    ).firstMatch
    XCTAssertTrue(
      fixture.exists, "Run scripts/check-ios-scanner.sh to seed the exported Swift fixture.")
    fixture.tap()
    XCTAssertTrue(app.navigationBars["Scan review"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Surface triangles"].exists)
    XCTAssertTrue(app.buttons["Sign in to upload"].exists || app.buttons["Upload unlisted map"].exists
      || app.buttons["Share map link"].exists || app.buttons["Check previous upload"].exists)
    let preview = app.descendants(matching: .any)["native-model-preview"].firstMatch
    XCTAssertTrue(preview.waitForExistence(timeout: 10))
    let from = preview.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.5))
    from.press(
      forDuration: 0.12,
      thenDragTo: preview.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.52)))
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "Offline native mesh review"
    attachment.lifetime = .keepAlways
    add(attachment)
    let prepare = app.buttons["Prepare LiDAR bundle"]
    for _ in 0..<4 where !prepare.isHittable { app.swipeUp() }
    XCTAssertTrue(prepare.isEnabled)
    prepare.tap()
    XCTAssertTrue(app.buttons["Share LiDAR bundle"].waitForExistence(timeout: 15))
    app.navigationBars["Scan review"].buttons["Done"].tap()
    XCTAssertTrue(fixture.waitForExistence(timeout: 5))
  }
}
