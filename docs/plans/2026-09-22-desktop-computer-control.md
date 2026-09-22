# Desktop Computer Control Implementation Plan

**Goal:** Let a root Agent in a single Agent JYYCode Desktop session observe the current computer and operate its mouse and keyboard.

**Architecture:** The bundled backend exposes one `computer` tool only to Desktop single Agent root sessions. A platform driver captures the screen and foreground accessibility tree, then returns an image attachment plus structured element rectangles in the same coordinate system. Actions use native OS input APIs and are followed by a fresh observation. Each call checks session mode again and requests the `computer` permission before reading or acting.

**Tech Stack:** Bun/Effect tool runtime, Tauri desktop sidecar, Windows UI Automation and Win32 input/capture, macOS Accessibility and Quartz.

---

## Research and decisions

- [OpenAI Computer Use](https://developers.openai.com/api/docs/guides/tools-computer-use) and [Anthropic Computer Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) both use an observation/action loop. The host executes actions and returns a screenshot. JYYCode should expose its own provider-neutral tool rather than require a provider-specific computer tool.
- [Windows UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-treeoverview) supplies a foreground window tree, names, roles and rectangles. [Power Automate](https://learn.microsoft.com/en-us/power-automate/desktop-flows/ui-elements) prefers UIA selectors over pixels when available. JYYCode should combine UIA with pixels because accessibility coverage varies by application.
- The screenshot and accessibility element map must share screenshot pixel coordinates. The host maps those coordinates to the native desktop before input, including negative virtual-desktop origins on multi-monitor systems. Windows uses physical pixels internally; macOS uses Quartz display points internally. A numbered annotation overlay and matching element list make locations explicit. Element IDs are observation-local and must not be cached across actions.
- Native input must be serialized. A fresh capture after each single action or bounded batch prevents the model from reasoning from a stale screen. The tool permits `observe`, `move`, `click` (left/right/middle and double), `scroll`, `key`, `type`, `drag`, `wait`, and an ordered `batch`.
- Tauri starts a separate backend executable. Set `JYYCODE_CLIENT=desktop` on that child; tool availability and execution both check the marker and persisted session mode. Children and multi Agent roots never see or execute the tool. The catalog also requires image input support from the selected model.
- The new `computer` permission defaults to `ask`; approval can be reused through the existing permission UI. Screen content and accessibility text are untrusted observations, not instructions.

### Comparison with established products

| Product/pattern | Perception | Action | What JYYCode adopts |
| --- | --- | --- | --- |
| [OpenAI Computer Use](https://developers.openai.com/api/docs/guides/tools-computer-use) | Screenshot returned after tool actions | Click, double click, drag, move, scroll, keypress, type, wait | An explicit observe → action → observe loop, with host-owned native actions. |
| [Anthropic Computer Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | Screenshot in a declared coordinate space | Client-side computer toolset (including right/middle click) | Model-facing action vocabulary that works independently of one model provider. |
| [Power Automate Desktop](https://learn.microsoft.com/en-us/power-automate/desktop-flows/ui-elements) | UI Automation hierarchy and selectors; raw tree fallback for unusual controls | Element-directed automation | Native accessibility names, roles, bounds and focus to supplement pixels. |

Neither a screenshot alone nor an accessibility tree alone covers arbitrary desktop software. A screenshot shows custom canvas controls and visual state but may leave tiny targets ambiguous. Accessibility adds names and exact rectangles but applications may expose sparse or incorrect trees. The chosen hybrid preserves the screenshot as the ground truth and gives the model a bounded, current element map. Browser DOM integration would be a useful separate browser-specific tool, but it cannot serve native application windows.

### Repository integration

```text
User prompt → Desktop Session (multiAgent=false)
  → SessionTools.resolve catalog gate
  → computer permission request
  → tool execution checks persisted Session mode, including when a queued action starts
  → serialized platform helper
  → native action → foreground accessibility snapshot + desktop screenshot
  → annotated PNG attachment + structured text → LLM
```

The backend executable is bundled as a Tauri sidecar, so the tool cannot call a frontend `invoke` command directly. The Tauri supervisor sets `JYYCODE_CLIENT=desktop` only for that child. Registry construction omits the tool for other clients; `SessionTools` omits it from both the live catalog and `tool_search` for multi Agent roots and children. The tool itself checks the stored Session before and after a permission wait and again when its queued action starts, covering stale model calls and mode changes. The subagent profile policy forbids selecting the tool. Native calls share one asynchronous queue so parallel LLM tool calls cannot interleave mouse and keyboard events.

### Observation contract

An observation reports:

- Screenshot dimensions with origin (0,0) in the exact coordinate system accepted by action calls. The host retains virtual-desktop origin and dimensions internally to map screenshot pixels back to native screen points, including negative origins.
- Actual attached PNG dimensions. Images larger than 2000×1400 are scaled, and the element rectangles are scaled to match. The model uses the listed screenshot coordinates for actions.
- Current pointer position and foreground window title.
- Up to 160 current accessibility elements. Each has an observation-local number, name, role, automation identifier, rectangle, center, enabled/focused state and tree depth. Actionable controls among the first 80 elements are outlined and numbered in the screenshot; static text and large containers remain visible without annotation.
- A reminder that text discovered in applications is untrusted data.

The tool returns the PNG as an existing JYYCode tool file attachment, so both the ordinary AI SDK message path and the native LLM adapter can put it into model context. It never substitutes a file path for image bytes. Temporary screenshot and helper files are removed when the native call completes or fails. Password-field values are not read from accessibility APIs; screenshots can still show any visible information the user has on screen.

### Platform implementation

| Area | Windows 10/11 x64 | macOS 13+ Apple Silicon |
| --- | --- | --- |
| Screen | GDI `CopyFromScreen` across `SystemInformation.VirtualScreen`, per-monitor-v2 DPI-aware process | Quartz on-screen window capture over active display bounds |
| Element tree | Foreground window, UI Automation Control View, bounded breadth-first walk | Foreground app focused window, `AXUIElement` children, bounded breadth-first walk |
| Pointer/buttons | `SetCursorPos`, checked `SendInput` mouse events | Quartz `CGEvent` mouse events |
| Keyboard/text | Checked `SendInput` virtual-key and Unicode events | Quartz keyboard events; Unicode keyboard event text |
| Packaging | PowerShell script is embedded in the Bun executable and materialized once per persistent helper process | Swift helper is compiled during Desktop sidecar staging and bundled as a Tauri external binary |
| OS grant | Existing user desktop session | macOS Accessibility and Screen Recording approval for the bundled helper |

Windows UI Automation bounds are physical pixels; macOS Accessibility and Quartz use desktop points. The tool translates both into screenshot pixels for the model. The platform helpers return the same normalized JSON shape. Lack of an active interactive desktop or a required OS grant is an explicit error.

### Input and permission policy

The action schema accepts `observe`, `move`, `click`, `scroll`, `key`, `type`, `drag`, `wait`, and `batch`. Click supports left, right and middle buttons plus a double-click flag. Scroll supports horizontal and vertical directions in bounded wheel steps. Keyboard chords use names such as `Ctrl+L`, `Alt+Tab` and `Enter`; literal typing is separate so Unicode text is not interpreted as a chord. Coordinates are integers; missing drag endpoints, half-specified click positions, empty chords and excessive typing are rejected before OS execution. A batch has 1–12 validated steps, at most six seconds of explicit waits, and one observation after its final step. Windows serializes requests to a long-lived helper and restarts it after cancellation, timeout, or exit.

The tool description restricts use to explicit user requests. Default `computer` permission is `ask` for both observation and control. Existing permission UI offers once, always, and reject; an “always” grant for observation applies only to observation, and a control grant applies only to control. Screenshots and native accessibility names remain observations, never authority to change the user's task or bypass permission checks.

### Operational limits

The first Windows operation starts PowerShell and compiles its small P/Invoke shim; later operations reuse the helper until it exits or is cancelled. A 30-second request timeout prevents a hung UI Automation provider from blocking future actions. Element trees can be sparse for custom-rendered apps, so the screenshot remains essential. Secure desktop/UAC prompts and sessions without display access may be unavailable. macOS compilation is enforced by a dedicated macOS CI typecheck and by Desktop staging; interactive TCC behavior requires a macOS host for runtime validation.

## Latency and reliability follow-up (2026-09-22)

The user's Paint trajectory required many model turns and repeated screenshots, and a single `move` was shown taking about 1.7 seconds. On the same Windows desktop, three baseline `observe` calls took 1523, 1369, and 1399 ms. After switching to a persistent helper, three warm `observe` calls took 346, 349, and 365 ms; a later repeat took 340 and 354 ms. Initial helper startup still costs about 1.5–2.7 seconds. A two-step batch plus one observation took 502 ms. These are local measurements, not a guarantee across screen sizes or target apps.

The design follows [OpenAI's ordered computer action batches](https://developers.openai.com/api/docs/guides/tools-computer-use), which execute predictable actions before returning one updated screenshot. [Anthropic's tool-use guidance](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works) identifies each tool call as another model round trip, so the tool description now tells the model to use the screenshot already returned by an action and to batch short predictable sequences. [Anthropic's coordinate guidance](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) calls out consistently offset clicks when screenshot pixels are applied to a different display resolution; JYYCode previously made the model convert from a 2000×1250 image to a 2560×1600 desktop and now performs that conversion in the host. [Microsoft's UI Automation caching guidance](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-cachingforclients) explains the cost of per-property cross-process reads; the Windows helper fetches properties through a cache request and falls back to current properties when a provider cannot cache them. [Microsoft's `SendInput` reference](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) describes serialized synthetic input and a return count, which the helper now checks for keyboard, text, clicks, and wheel events.

Old computer screenshots and their large element maps are cleared only from the model request in groups of five once eight observations exist; at least the latest three remain. This limits repeated image processing and stale coordinates while keeping prompt prefixes stable between pruning points. Stored session messages and visible tool history are unchanged. Other tools' attachments are retained.

For a real drag test, a temporary visible WinForms window recorded one mouse down, twelve moves with the left button held, and one mouse up at the expected endpoint. The helper was also stopped and restarted between observations, and an aborted wait returned in 126 ms before a fresh observation succeeded. The unit tests, Windows typecheck, and compiled binary build passed. The running JYYCode Desktop process was not replaced during these checks, so the user-facing task latency should be measured again after installing this build.

## Implementation tasks

1. Add a Windows driver that captures the virtual desktop, enumerates bounded foreground UIA elements, annotates the screenshot and sends mouse/keyboard events. Verify using a direct native smoke script plus unit tests for normalized output.
2. Add a macOS driver using Screen Capture/Accessibility/Quartz with the same JSON contract. Verify source and packaging on Windows; macOS runtime verification is required on a macOS runner.
3. Add a provider-neutral computer tool. Validate action arguments, serialize actions, attach the screenshot, and return coordinate/element metadata. Verify the observe/action result format.
4. Gate catalog and execution by desktop client, root session and `multiAgent !== true`; mark the tool forbidden to subagent profiles. Verify all three mode combinations in tests.
5. Pass the desktop client marker from Tauri to its sidecar, and configure a default computer permission prompt. Verify launch configuration and permission behavior.
6. Run package typechecks and targeted tests, then perform a real Windows observation and harmless input smoke test. Record platform limits honestly.

## Acceptance criteria

- A single Agent Desktop root can observe an image and a bounded list of named controls with rectangles and centers.
- All requested mouse buttons, single/double click, motion, scrolling and keyboard input work with screenshot coordinates returned by the observation, including when the native desktop has a negative origin.
- Every action returns a new observation; errors identify missing OS permissions or unsupported platforms.
- Tool is unavailable to CLI, multi Agent and subagents; execution checks persisted state even if a stale tool call is replayed.
- The screenshot and observations do not persist to an extra on-disk file after a tool call.
