import UIKit
import UniformTypeIdentifiers
final class ShareViewController: UIViewController {
  private let label = UILabel()
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    preferredContentSize = CGSize(width: 380, height: 300)
    label.numberOfLines = 0; label.textAlignment = .center; label.text = "Checking video link…"
    label.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(label)
    let close = UIButton(type: .system); close.setTitle("Done", for: .normal)
    close.translatesAutoresizingMaskIntoConstraints = false; close.addTarget(self, action: #selector(finish), for: .touchUpInside); view.addSubview(close)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28), label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28), label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
      close.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 24), close.centerXAnchor.constraint(equalTo: view.centerXAnchor), close.heightAnchor.constraint(greaterThanOrEqualToConstant: 48), close.bottomAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -20)])
    Task { await receive() }
  }
  @objc private func finish() { extensionContext?.completeRequest(returningItems: nil) }
  @MainActor private func receive() async {
    var candidates = Set<String>()
    for item in extensionContext?.inputItems as? [NSExtensionItem] ?? [] {
      if let text = item.attributedContentText?.string { candidates.insert(text) }
      for provider in item.attachments ?? [] {
        for type in [UTType.url.identifier, UTType.plainText.identifier] where provider.hasItemConformingToTypeIdentifier(type) {
          let value: NSSecureCoding? = await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, _ in continuation.resume(returning: item) }
          }
          if let url = value as? URL { candidates.insert(url.absoluteString) }
          else if let text = value as? String { candidates.insert(text) }
        }
      }
    }
    let urls = Set(candidates.flatMap { LinkParser.supported(in: $0) })
    guard urls.count == 1, let url = urls.first else { label.text = "Share one Instagram Reel/post or TikTok video link. You can also paste the link in Lynxr."; return }
    do { try SharedInbox.save(url); label.text = "Link saved. Open Lynxr to confirm your account, brand and generation request. Nothing has been submitted yet." }
    catch { label.text = "Couldn’t save this link. Open Lynxr and paste it there." }
  }
}
