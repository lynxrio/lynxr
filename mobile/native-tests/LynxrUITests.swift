import XCTest

final class LynxrUITests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "io.lynxr.mobile")
  override func setUpWithError() throws { continueAfterFailure = false }
  func button(_ title: String) -> XCUIElement { app.buttons[title].firstMatch }
  func tap(_ title: String) { if button("Not Now").exists { button("Not Now").tap() }; let b = button(title); if !b.isHittable { app.swipeUp() }; XCTAssertTrue(b.waitForExistence(timeout: 10), title); b.tap() }
  func signIn(address: String = "ios-local@example.invalid") {
    app.launch()
    if button("Account").waitForExistence(timeout: 4) {
      if app.staticTexts[address].exists { return }
      tap("Account"); tap("Sign out")
      XCTAssertTrue(button("Sign in").waitForExistence(timeout: 10))
    }
    let email = app.textFields["Email"]
    XCTAssertTrue(email.waitForExistence(timeout: 30))
    email.tap()
    for c in address { email.typeText(String(c)) }
    XCTAssertEqual(email.value as? String, address)
    let pass = app.secureTextFields["Password"]; pass.tap(); for c in "LynxrLocalOnly42!" { pass.typeText(String(c)) }
    tap("Sign in")
    let signedIn = button("Account").waitForExistence(timeout: 20)
    if !signedIn { print(app.debugDescription) }
    XCTAssertTrue(signedIn)
    if button("Not Now").waitForExistence(timeout: 2) { button("Not Now").tap() }
  }
  func test01SignInAndSessionRecovery() {
    signIn()
    app.terminate(); app.launch()
    XCTAssertTrue(button("Account").waitForExistence(timeout: 20))
    XCTAssertTrue(button("Make a script / Shared links").exists)
    let shot = XCTAttachment(screenshot: app.screenshot()); shot.name="Authenticated library"; shot.lifetime = .keepAlways; add(shot)
  }
  func test02SubmitRecoverAndCopy() {
    signIn(); tap("Make a script / Shared links")
    let url = app.textFields["Video URL"]; XCTAssertTrue(url.waitForExistence(timeout: 10))
    url.tap(); for c in "https://www.instagram.com/reel/LocalUITest/" { url.typeText(String(c)) }
    // Dismiss keyboard without changing the form.
    app.swipeUp()
    let consent=app.switches["Content rights and AI processing consent"]
    for _ in 0..<4 where !consent.isHittable { app.swipeUp() }
    XCTAssertTrue(consent.exists); consent.tap()
    tap("Review source and brand")
    tap("Generate script")
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label MATCHES[c] %@", "Queued|Processing|Completed")).firstMatch.waitForExistence(timeout: 10))
    app.terminate(); app.launch()
    XCTAssertTrue(button("Account").waitForExistence(timeout: 15))
    let row=app.buttons.matching(NSPredicate(format:"label CONTAINS %@", "Local pipeline integration test")).firstMatch
    // Manual refresh avoids assuming the background polling interval.
    for _ in 0..<5 where !row.exists { tap("Refresh library"); Thread.sleep(forTimeInterval: 2) }
    XCTAssertTrue(row.waitForExistence(timeout: 10)); row.tap()
    XCTAssertTrue(button("Copy script").waitForExistence(timeout: 10)); tap("Copy script")
    XCTAssertTrue(button("Copied").exists)
    let shot=XCTAttachment(screenshot:app.screenshot()); shot.name="Completed local injected-processor job"; shot.lifetime = .keepAlways; add(shot)
  }
  func test03NativeShareIntake() {
    signIn()
    app.terminate()
    let host = XCUIApplication(bundleIdentifier: "io.lynxr.share-test-host")
    host.launch(); host.buttons["Share test video URL"].tap()
    let target=host.cells["Lynxr"].firstMatch
    if !target.waitForExistence(timeout: 5) {
      let more=host.cells.matching(NSPredicate(format:"label CONTAINS %@","More")).firstMatch
      if more.exists { more.tap() }
    }
    let exists = target.waitForExistence(timeout: 10)
    if !exists { print(host.debugDescription) }
    XCTAssertTrue(exists); target.tap()
    XCTAssertTrue(host.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@","Link saved.")).firstMatch.waitForExistence(timeout: 10))
    let shot=XCTAttachment(screenshot:host.screenshot()); shot.name="Native Share Extension saved URL"; shot.lifetime = .keepAlways; add(shot)
    host.buttons["Done"].firstMatch.tap()
    host.terminate(); app.launch(); tap("Make a script / Shared links")
    XCTAssertTrue(button("Use shared link").waitForExistence(timeout: 10))
  }
  func test04SignOutAndAccountIsolation() {
    signIn()
    XCTAssertTrue(app.buttons.matching(NSPredicate(format:"label CONTAINS %@", "Local pipeline integration test")).firstMatch.waitForExistence(timeout: 10))
    tap("Account"); tap("Sign out")
    XCTAssertTrue(button("Sign in").waitForExistence(timeout: 10))
    signIn(address: "ios-local-b@example.invalid")
    XCTAssertTrue(app.staticTexts["ios-local-b@example.invalid"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Your saved scripts will appear here."].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons.matching(NSPredicate(format:"label CONTAINS %@", "Local pipeline integration test")).firstMatch.exists)
    tap("Make a script / Shared links")
    let formExists = app.textFields["Video URL"].waitForExistence(timeout: 10)
    if !formExists { print(app.debugDescription) }
    XCTAssertTrue(formExists)
    XCTAssertFalse(button("Use shared link").exists)
    tap("Back to library"); tap("Account"); tap("Sign out")
    signIn()
  }

}
