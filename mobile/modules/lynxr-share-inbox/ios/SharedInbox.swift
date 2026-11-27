import Foundation
import Darwin

struct SharedLink: Codable {
  let id: String
  let url: String
  let owner: String?
  let createdAt: String
}

enum SharedInbox {
  static var group: String { Bundle.main.object(forInfoDictionaryKey: "LynxrAppGroup") as? String ?? "" }
  static func locked<T>(_ action: (URL) throws -> T) throws -> T {
    guard !group.isEmpty, let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw NSError(domain: "LynxrInbox", code: 1) }
    let dir = root.appendingPathComponent("Inbox", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    let fd = open(dir.appendingPathComponent(".lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw NSError(domain: "LynxrInbox", code: 2) }
    defer { flock(fd, LOCK_UN); close(fd) }
    guard flock(fd, LOCK_EX) == 0 else { throw NSError(domain: "LynxrInbox", code: 3) }
    return try action(dir)
  }
  static func files(_ dir: URL) throws -> [URL] {
    try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
  }
  static func owner(_ dir: URL) -> String? {
    guard let d = try? Data(contentsOf: dir.appendingPathComponent("owner")), let s = String(data: d, encoding: .utf8), !s.isEmpty else { return nil }
    return s
  }
  static func setOwner(_ next: String?) throws {
    try locked { dir in
      let old = owner(dir)
      if old != next && old != nil { for file in try files(dir) { try FileManager.default.removeItem(at: file) } }
      try (next ?? "").data(using: .utf8)!.write(to: dir.appendingPathComponent("owner"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
  }
  static func save(_ url: String) throws {
    try locked { dir in
      let existing = try files(dir)
      if existing.count >= 30 { throw NSError(domain: "LynxrInboxFull", code: 4) }
      let who = owner(dir)
      for file in existing {
        if let d = try? Data(contentsOf: file), let item = try? JSONDecoder().decode(SharedLink.self, from: d), item.url == url && item.owner == who { return }
      }
      let item = SharedLink(id: UUID().uuidString, url: url, owner: who, createdAt: ISO8601DateFormatter().string(from: Date()))
      try JSONEncoder().encode(item).write(to: dir.appendingPathComponent(item.id + ".json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
  }
  static func list(_ expected: String) throws -> String {
    try locked { dir in
      guard owner(dir) == expected else { throw NSError(domain: "LynxrAccountChanged", code: 5) }
      let links = try files(dir).compactMap { file -> SharedLink? in
        guard let data = try? Data(contentsOf: file), let item = try? JSONDecoder().decode(SharedLink.self, from: data), item.owner == nil || item.owner == expected else { return nil }
        return item
      }.sorted { $0.createdAt < $1.createdAt }
      return String(data: try JSONEncoder().encode(links), encoding: .utf8)!
    }
  }
  static func acknowledge(_ id: String, expected: String) throws {
    guard UUID(uuidString: id) != nil else { return }
    try locked { dir in
      guard owner(dir) == expected else { throw NSError(domain: "LynxrAccountChanged", code: 5) }
      let path = dir.appendingPathComponent(id + ".json")
      if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
    }
  }
}
