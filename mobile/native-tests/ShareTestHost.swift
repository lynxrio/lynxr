// Separate local test sender. It has no App Group, credentials or network code.
import SwiftUI

@main struct ShareTestHost: App {
  @State private var sharing = false
  var body: some Scene {
    WindowGroup {
      VStack(spacing: 24) {
        Text("Local Share Extension test sender")
        Text("No video is fetched or generated.")
        Button("Share test video URL") { sharing = true }
      }.padding().sheet(isPresented: $sharing) { ShareActivity() }
    }
  }
}
struct ShareActivity: UIViewControllerRepresentable {
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: ["https://www.instagram.com/reel/LocalNativeShare/"], applicationActivities: nil)
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
