import Foundation
enum LinkParser {
  static func supported(in text: String) -> [String] {
    guard text.count <= 4096, let re = try? NSRegularExpression(pattern: "https://[^\\s<>]+") else { return [] }
    return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { hit in
      guard let range = Range(hit.range, in: text), let c = URLComponents(string: String(text[range])), c.scheme == "https", c.user == nil, c.password == nil, c.port == nil, let host = c.host?.lowercased() else { return nil }
      func captures(_ pattern: String) -> [String]? {
        guard let r = try? NSRegularExpression(pattern: pattern), let m = r.firstMatch(in: c.path, range: NSRange(c.path.startIndex..., in: c.path)) else { return nil }
        return (1..<m.numberOfRanges).compactMap { Range(m.range(at: $0), in: c.path).map { String(c.path[$0]) } }
      }
      if ["instagram.com", "www.instagram.com"].contains(host), let m = captures("^/(?:reel|reels|p)/([A-Za-z0-9_-]+)/?$") { return "https://www.instagram.com/reel/\(m[0])/" }
      if ["tiktok.com", "www.tiktok.com"].contains(host), let m = captures("^/(@[A-Za-z0-9._-]+)/video/([0-9]+)/?$") { return "https://www.tiktok.com/\(m[0])/video/\(m[1])" }
      if ["vm.tiktok.com", "vt.tiktok.com"].contains(host), let m = captures("^/([A-Za-z0-9]+)/?$") { return "https://\(host)/\(m[0])/" }
      return nil
    }
  }
}
