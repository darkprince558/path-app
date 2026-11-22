import XCTest

final class PathCaptureUITests: XCTestCase {
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
    XCTAssertTrue(app.staticTexts["Scan a space"].waitForExistence(timeout: 15))
    let fixture = app.buttons.containing(
      NSPredicate(format: "label CONTAINS %@", "Synthetic wall fixture")
    ).firstMatch
    XCTAssertTrue(
      fixture.exists, "Run scripts/check-ios-scanner.sh to seed the exported Swift fixture.")
    fixture.tap()
    XCTAssertTrue(app.navigationBars["Scan review"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Surface triangles"].exists)
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
    app.buttons["Done"].tap()
    XCTAssertTrue(fixture.waitForExistence(timeout: 5))
  }
}
