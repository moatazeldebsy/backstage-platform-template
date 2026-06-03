@testable import ${{ values.name | replace('-', '_') }}
import XCTest

final class AppTests: XCTestCase {

    override func setUpWithError() throws {
        // Put setup code here. This method is called before the invocation of each test method in the class.
    }

    override func tearDownWithError() throws {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
    }

    func testAppInitializes() throws {
        // Basic sanity test — the module loads without crashing.
        XCTAssertTrue(true, "${{ values.name }} should initialize successfully")
    }

    func testExamplePerformance() throws {
        measure {
            // Add performance tests here.
        }
    }
}
