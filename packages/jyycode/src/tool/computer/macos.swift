import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Point: Encodable { let x: Int; let y: Int }
struct Rect: Encodable { let x: Int; let y: Int; let width: Int; let height: Int }
struct ImageSize: Encodable { let width: Int; let height: Int }
struct Monitor: Encodable {
  let id: String
  let bounds: Rect
  let pixelScaleX: Double
  let pixelScaleY: Double
}
struct Element: Encodable {
  let index: Int
  let name: String
  let role: String
  let automationId: String
  let x: Int
  let y: Int
  let width: Int
  let height: Int
  let enabled: Bool
  let focused: Bool
  let depth: Int
}
struct Observation: Encodable {
  let screen: Rect
  let image: ImageSize
  let rawImage: ImageSize
  let monitors: [Monitor]
  let cursor: Point
  let window: String
  let windowID: String?
  let elements: [Element]
}

func fail(_ message: String) -> Never {
  fputs("\(message)\n", stderr)
  exit(1)
}

func property(_ data: [String: Any], _ key: String) -> String { data[key] as? String ?? "" }
func integer(_ data: [String: Any], _ key: String) -> Int? { data[key] as? Int }
func axAttribute(_ element: AXUIElement, _ key: CFString) -> CFTypeRef? {
  var result: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, key, &result) == .success ? result : nil
}
func axString(_ element: AXUIElement, _ key: CFString) -> String {
  axAttribute(element, key) as? String ?? ""
}
func axBoolean(_ element: AXUIElement, _ key: CFString, fallback: Bool) -> Bool {
  axAttribute(element, key) as? Bool ?? fallback
}
func axPoint(_ element: AXUIElement) -> CGPoint? {
  guard let value = axAttribute(element, kAXPositionAttribute as CFString) else { return nil }
  let ax = value as! AXValue
  var point = CGPoint.zero
  return AXValueGetValue(ax, .cgPoint, &point) ? point : nil
}
func axSize(_ element: AXUIElement) -> CGSize? {
  guard let value = axAttribute(element, kAXSizeAttribute as CFString) else { return nil }
  let ax = value as! AXValue
  var size = CGSize.zero
  return AXValueGetValue(ax, .cgSize, &size) ? size : nil
}
func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  axAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}
func axElement(_ value: CFTypeRef?) -> AXUIElement? {
  guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return value as! AXUIElement
}

func emitMouse(_ kind: CGEventType, _ position: CGPoint, _ button: CGMouseButton = .left) {
  guard let event = CGEvent(mouseEventSource: nil, mouseType: kind, mouseCursorPosition: position, mouseButton: button) else {
    fail("Could not create mouse event")
  }
  event.post(tap: .cghidEventTap)
}
func currentCursor() -> CGPoint {
  CGEvent(source: nil)?.location ?? CGPoint.zero
}
func foregroundID() -> String? {
  NSWorkspace.shared.frontmostApplication.map { String($0.processIdentifier) }
}
func assertWindow(_ data: [String: Any]) {
  if let expected = data["expectWindow"] as? String, !expected.isEmpty && foregroundID() != expected {
    fail("Foreground window changed since the last observation; observe and refocus the target before clicking or dragging")
  }
}
func position(_ data: [String: Any]) -> CGPoint {
  guard let x = integer(data, "x"), let y = integer(data, "y") else { return currentCursor() }
  return CGPoint(x: CGFloat(x), y: CGFloat(y))
}
func keyCode(_ key: String) -> CGKeyCode? {
  let codes: [String: Int] = [
    "a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,
    "1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46,
    "enter":36,"return":36,"tab":48,"space":49,"delete":117,"backspace":51,"escape":53,"esc":53,"left":123,"right":124,"down":125,"up":126,
    "home":115,"end":119,"pageup":116,"pagedown":121,"ctrl":59,"control":59,"shift":56,"alt":58,"option":58,"cmd":55,"command":55,"meta":55,"super":55,
    "f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,"f11":103,"f12":111,
  ]
  guard let value = codes[key.lowercased()] else { return nil }
  return CGKeyCode(value)
}
func emitKey(_ code: CGKeyCode, _ down: Bool) {
  guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { fail("Could not create keyboard event") }
  event.post(tap: .cghidEventTap)
}

guard CommandLine.arguments.count >= 3 else { fail("Missing output path or action payload") }
let imagePath = CommandLine.arguments[1]
guard let payload = Data(base64Encoded: CommandLine.arguments[2]),
      let data = (try? JSONSerialization.jsonObject(with: payload)) as? [String: Any] else { fail("Invalid action payload") }
let action = property(data, "action")
let includeElements = (data["annotate"] as? Bool == true) || (data["includeElements"] as? Bool ?? (action == "observe"))
let trustOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
if !AXIsProcessTrustedWithOptions(trustOptions) {
  fail("macOS Accessibility permission is required for JYYCode computer control; grant it in System Settings and retry")
}
if !CGPreflightScreenCaptureAccess() {
  _ = CGRequestScreenCaptureAccess()
  fail("macOS Screen Recording permission is required for JYYCode computer control; grant it in System Settings and retry")
}

func perform(_ data: [String: Any]) {
switch property(data, "action") {
case "observe": break
case "move": emitMouse(.mouseMoved, position(data))
case "click":
  assertWindow(data)
  let point = position(data)
  if integer(data, "x") != nil { emitMouse(.mouseMoved, point) }
  let button = property(data, "button").isEmpty ? "left" : property(data, "button")
  let mouseButton: CGMouseButton = button == "right" ? .right : button == "middle" ? .center : .left
  let down: CGEventType = button == "right" ? .rightMouseDown : button == "middle" ? .otherMouseDown : .leftMouseDown
  let up: CGEventType = button == "right" ? .rightMouseUp : button == "middle" ? .otherMouseUp : .leftMouseUp
  for index in 0..<(data["double"] as? Bool == true ? 2 : 1) {
    let downEvent = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: point, mouseButton: mouseButton)!
    let upEvent = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: point, mouseButton: mouseButton)!
    if data["double"] as? Bool == true {
      downEvent.setIntegerValueField(.mouseEventClickState, value: Int64(index + 1))
      upEvent.setIntegerValueField(.mouseEventClickState, value: Int64(index + 1))
    }
    downEvent.post(tap: .cghidEventTap)
    upEvent.post(tap: .cghidEventTap)
    usleep(70000)
  }
case "scroll":
  assertWindow(data)
  if integer(data, "x") != nil { emitMouse(.mouseMoved, position(data)) }
  let amount = Int32(integer(data, "amount") ?? 1)
  let direction = property(data, "direction")
  let vertical: Int32 = direction == "up" ? amount : direction == "down" ? -amount : 0
  let horizontal: Int32 = direction == "right" ? amount : direction == "left" ? -amount : 0
  guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0) else { fail("Could not create scroll event") }
  event.post(tap: .cghidEventTap)
case "key":
  let names = property(data, "keys").split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
  let codes = names.map { keyCode($0) }
  if codes.contains(where: { $0 == nil }) { fail("Unsupported key combination: \(property(data, "keys"))") }
  for code in codes { emitKey(code!, true) }
  for code in codes.reversed() { emitKey(code!, false) }
case "type":
  for character in property(data, "text") {
    let units = Array(String(character).utf16)
    for down in [true, false] {
      guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { fail("Could not create text event") }
      units.withUnsafeBufferPointer { buffer in
        event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!)
      }
      event.post(tap: .cghidEventTap)
    }
  }
case "drag":
  assertWindow(data)
  if let points = data["points"] as? [[String: Any]], let first = points.first, let last = points.last,
      let startX = integer(first, "x"), let startY = integer(first, "y"),
      let endX = integer(last, "x"), let endY = integer(last, "y") {
    let start = CGPoint(x: CGFloat(startX), y: CGFloat(startY))
    emitMouse(.mouseMoved, start)
    emitMouse(.leftMouseDown, start)
    var current = start
    for item in points.dropFirst() {
      if let expected = data["expectWindow"] as? String, !expected.isEmpty && foregroundID() != expected {
        emitMouse(.leftMouseUp, current)
        fail("Foreground window changed during drag")
      }
      guard let x = integer(item, "x"), let y = integer(item, "y") else { emitMouse(.leftMouseUp, current); fail("Invalid drag point") }
      current = CGPoint(x: CGFloat(x), y: CGFloat(y))
      emitMouse(.leftMouseDragged, current)
      usleep(8000)
    }
    emitMouse(.leftMouseUp, CGPoint(x: CGFloat(endX), y: CGFloat(endY)))
    break
  }
  let start = position(data)
  guard let toX = integer(data, "toX"), let toY = integer(data, "toY") else { fail("Missing drag destination") }
  emitMouse(.mouseMoved, start)
  emitMouse(.leftMouseDown, start)
  for step in 1...12 {
    if let expected = data["expectWindow"] as? String, !expected.isEmpty && foregroundID() != expected {
      emitMouse(.leftMouseUp, currentCursor())
      fail("Foreground window changed during drag")
    }
    let fraction = CGFloat(step) / 12
    let point = CGPoint(x: start.x + (CGFloat(toX) - start.x) * fraction, y: start.y + (CGFloat(toY) - start.y) * fraction)
    emitMouse(.leftMouseDragged, point)
    usleep(15000)
  }
  emitMouse(.leftMouseUp, CGPoint(x: CGFloat(toX), y: CGFloat(toY)))
case "wait":
  let milliseconds = integer(data, "milliseconds") ?? 0
  let wanted = property(data, "untilWindow")
  if wanted.isEmpty { usleep(useconds_t(milliseconds) * 1000); break }
  let deadline = Date().addingTimeInterval(Double(milliseconds) / 1000)
  var found = false
  repeat {
    if NSWorkspace.shared.frontmostApplication?.localizedName?.localizedCaseInsensitiveContains(wanted) == true {
      found = true
      break
    }
    usleep(50000)
  } while Date() < deadline
  if !found { fail("Timed out waiting for foreground application containing: \(wanted)") }
default: fail("Unsupported action: \(property(data, "action"))")
}
}
if action == "batch" {
  guard let steps = data["steps"] as? [[String: Any]] else { fail("Invalid batch steps") }
  for (index, step) in steps.enumerated() {
    perform(step)
    if index + 1 < steps.count && property(steps[index + 1], "action") != "wait" &&
        ["click", "key"].contains(property(step, "action")) { usleep(50000) }
  }
} else { perform(data) }
if action != "observe" && action != "wait" { usleep(100000) }

var displayIDs = [CGDirectDisplayID](repeating: 0, count: 32)
var displayCount: UInt32 = 0
guard CGGetActiveDisplayList(32, &displayIDs, &displayCount) == .success && displayCount > 0 else { fail("No active display") }
let bounds = displayIDs.prefix(Int(displayCount)).map { CGDisplayBounds($0) }.reduce(CGRect.null) { $0.union($1) }
guard !bounds.isNull else { fail("No desktop bounds") }
guard let capture = CGWindowListCreateImage(bounds, .optionOnScreenOnly, kCGNullWindowID, [.nominalResolution]) else {
  fail("macOS Screen Recording permission is required for JYYCode screenshots")
}
if let rawImagePath = data["rawImagePath"] as? String, !rawImagePath.isEmpty {
  guard let rawDestination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: rawImagePath) as CFURL,
    UTType.png.identifier as CFString, 1, nil) else { fail("Could not create raw screenshot") }
  CGImageDestinationAddImage(rawDestination, capture, nil)
  guard CGImageDestinationFinalize(rawDestination) else { fail("Could not save raw screenshot") }
}
let originX = Int(bounds.minX.rounded())
let originY = Int(bounds.minY.rounded())
let screenWidth = Int(bounds.width.rounded())
let screenHeight = Int(bounds.height.rounded())
let monitors = displayIDs.prefix(Int(displayCount)).map { displayID -> Monitor in
  let box = CGDisplayBounds(displayID)
  return Monitor(id: String(displayID),
    bounds: Rect(x: Int(box.minX.rounded()), y: Int(box.minY.rounded()),
      width: Int(box.width.rounded()), height: Int(box.height.rounded())),
    pixelScaleX: box.width > 0 ? Double(CGDisplayPixelsWide(displayID)) / Double(box.width) : 1,
    pixelScaleY: box.height > 0 ? Double(CGDisplayPixelsHigh(displayID)) / Double(box.height) : 1)
}

var elements: [Element] = []
var windowName = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
if includeElements, let app = NSWorkspace.shared.frontmostApplication {
  let root = AXUIElementCreateApplication(app.processIdentifier)
  let window = axElement(axAttribute(root, kAXFocusedWindowAttribute as CFString))
    ?? ((axAttribute(root, kAXWindowsAttribute as CFString) as? [AXUIElement])?.first)
  windowName = window.map { axString($0, kAXTitleAttribute as CFString) } ?? app.localizedName ?? ""
  if let window {
    var queue: [(AXUIElement, Int)] = [(window, 0)]
    var visited = 0
    while !queue.isEmpty && elements.count < 160 && visited < 800 {
      let (element, depth) = queue.removeFirst()
      visited += 1
      if let point = axPoint(element), let size = axSize(element), size.width > 2, size.height > 2 {
        let rectangle = CGRect(origin: point, size: size)
        if rectangle.intersects(bounds) {
          let role = axString(element, kAXRoleAttribute as CFString).replacingOccurrences(of: "AX", with: "")
          var name = axString(element, kAXTitleAttribute as CFString)
          if name.isEmpty { name = axString(element, kAXDescriptionAttribute as CFString) }
          if name.isEmpty && role == "StaticText" { name = axString(element, kAXValueAttribute as CFString) }
          let identifier = axString(element, kAXIdentifierAttribute as CFString)
          if !name.isEmpty || !identifier.isEmpty || ["Button", "TextField", "MenuItem", "CheckBox", "RadioButton", "ComboBox"].contains(role) {
            elements.append(Element(index: elements.count + 1, name: String(name.prefix(140)), role: role, automationId: identifier,
              x: Int(point.x.rounded()), y: Int(point.y.rounded()), width: Int(size.width.rounded()), height: Int(size.height.rounded()),
              enabled: axBoolean(element, kAXEnabledAttribute as CFString, fallback: true),
              focused: axBoolean(element, kAXFocusedAttribute as CFString, fallback: false), depth: depth))
          }
        }
      }
      if depth < 8 { queue.append(contentsOf: axChildren(element).prefix(100).map { ($0, depth + 1) }) }
    }
  }
}

let maxWidth: CGFloat = property(data, "resolution") == "high" ? 2000 : 1280
let maxHeight: CGFloat = property(data, "resolution") == "high" ? 1400 : 800
let scale = min(1.0, min(maxWidth / CGFloat(capture.width), maxHeight / CGFloat(capture.height)))
let imageWidth = max(1, Int((CGFloat(capture.width) * scale).rounded()))
let imageHeight = max(1, Int((CGFloat(capture.height) * scale).rounded()))
let colorSpace = CGColorSpaceCreateDeviceRGB()
guard let context = CGContext(data: nil, width: imageWidth, height: imageHeight, bitsPerComponent: 8,
  bytesPerRow: 0, space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("Could not create image buffer") }
context.draw(capture, in: CGRect(x: 0, y: 0, width: CGFloat(imageWidth), height: CGFloat(imageHeight)))
if data["annotate"] as? Bool == true {
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
  let xScale = CGFloat(imageWidth) / bounds.width
  let yScale = CGFloat(imageHeight) / bounds.height
  context.setStrokeColor(CGColor(red: 1, green: 0.3, blue: 0.17, alpha: 0.9))
  context.setLineWidth(2)
  for element in elements.prefix(80) {
    if !["Button", "TextField", "TextArea", "MenuItem", "TabItem", "ListItem", "CheckBox", "RadioButton", "ComboBox", "Link", "ScrollBar", "Slider"].contains(element.role) { continue }
    let rect = CGRect(x: CGFloat(element.x - originX) * xScale,
      y: CGFloat(imageHeight) - CGFloat(element.y - originY + element.height) * yScale,
      width: CGFloat(element.width) * xScale, height: CGFloat(element.height) * yScale)
    if rect.width < 8 || rect.height < 8 { continue }
    context.stroke(rect)
    let label = "\(element.index)" as NSString
    let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: 11), .foregroundColor: NSColor.white]
    let size = label.size(withAttributes: attributes)
    context.setFillColor(CGColor(red: 1, green: 0.3, blue: 0.17, alpha: 0.95))
    context.fill(CGRect(x: rect.minX, y: rect.maxY - size.height - 3, width: size.width + 5, height: size.height + 3))
    label.draw(at: NSPoint(x: rect.minX + 2, y: rect.maxY - size.height - 1), withAttributes: attributes)
  }
  NSGraphicsContext.restoreGraphicsState()
}
guard let result = context.makeImage(), let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: imagePath) as CFURL, UTType.png.identifier as CFString, 1, nil) else {
  fail("Could not create screenshot")
}
CGImageDestinationAddImage(destination, result, nil)
guard CGImageDestinationFinalize(destination) else { fail("Could not save screenshot") }
let cursor = currentCursor()
let observation = Observation(screen: Rect(x: originX, y: originY, width: screenWidth, height: screenHeight),
  image: ImageSize(width: imageWidth, height: imageHeight),
  rawImage: ImageSize(width: capture.width, height: capture.height), monitors: monitors,
  cursor: Point(x: Int(cursor.x), y: Int(cursor.y)),
  window: windowName, windowID: foregroundID(), elements: elements)
let encoded = try JSONEncoder().encode(observation)
FileHandle.standardOutput.write(encoded)
