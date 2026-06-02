import SwiftUI

@main
struct ${{ values.name | replace('-', '_') | title }}App: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
