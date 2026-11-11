import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]) else {
  exit(2)
}
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID)
        as? [[String: Any]] else {
  exit(3)
}
let windows = raw.filter { window in
  (window[kCGWindowOwnerPID as String] as? Int32) == pid &&
  (window[kCGWindowLayer as String] as? Int) == 0 &&
  ((window[kCGWindowBounds as String] as? [String: CGFloat])?["Width"] ?? 0) >= 640 &&
  ((window[kCGWindowBounds as String] as? [String: CGFloat])?["Height"] ?? 0) >= 480
}
print("native-workspace-windows=\(windows.count)")
if let identifier = windows.first?[kCGWindowNumber as String] as? Int {
  print("native-workspace-window-id=\(identifier)")
}
exit(windows.isEmpty ? 1 : 0)
