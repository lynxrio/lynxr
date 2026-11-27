import Foundation

let cases: [(String, [String])] = [
  ("Watch https://instagram.com/reel/Ab_12/?igsh=test", ["https://www.instagram.com/reel/Ab_12/"]),
  ("https://www.instagram.com/p/ABC/", ["https://www.instagram.com/reel/ABC/"]),
  ("https://www.instagram.com/reels/ABC/", ["https://www.instagram.com/reel/ABC/"]),
  ("https://www.tiktok.com/@creator.name/video/123?x=1", ["https://www.tiktok.com/@creator.name/video/123"]),
  ("https://vm.tiktok.com/ABC/", ["https://vm.tiktok.com/ABC/"]),
  ("https://vt.tiktok.com/ABC/", ["https://vt.tiktok.com/ABC/"]),
  ("https://instagram.com.evil.invalid/reel/x/", []),
  ("https://attacker@instagram.com/reel/x/", []),
  ("https://instagram.com/user/", []),
  ("http://instagram.com/reel/x/", []),
  ("https://instagram.com/reel/a/ https://instagram.com/reel/b/", ["https://www.instagram.com/reel/a/", "https://www.instagram.com/reel/b/"])
]
for (input, expected) in cases { precondition(LinkParser.supported(in: input) == expected) }
print("11 native URL-parser cases passed. No network calls.")
