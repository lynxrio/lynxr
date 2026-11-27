import ExpoModulesCore
public class LynxrShareInboxModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LynxrShareInbox")
    AsyncFunction("setOwner") { (owner: String?) in if !SharedInbox.group.isEmpty { try SharedInbox.setOwner(owner) } }
    AsyncFunction("list") { (owner: String) in SharedInbox.group.isEmpty ? "[]" : try SharedInbox.list(owner) }
    AsyncFunction("acknowledge") { (id: String, owner: String) in if !SharedInbox.group.isEmpty { try SharedInbox.acknowledge(id, expected: owner) } }
  }
}
