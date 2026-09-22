# Desktop Computer Control Implementation Plan

**Goal:** Let a root Agent in a single Agent JYYCode Desktop session observe the current computer and operate its mouse and keyboard.

**Architecture:** The bundled backend exposes one `computer` tool only to Desktop single Agent root sessions. A platform driver captures the screen and foreground accessibility tree, then returns an image attachment plus structured element rectangles in the same coordinate system. Actions use native OS input APIs and are followed by a fresh observation. Each call checks session mode again and requests the `computer` permission before reading or acting.

**Tech Stack:** Bun/Effect tool runtime, Tauri desktop sidecar, Windows UI Automation and Win32 input/capture, macOS Accessibility and Quartz.

---

## Research and decisions

- [OpenAI Computer Use](https://developers.openai.com/api/docs/guides/tools-computer-use) and [Anthropic Computer Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) both use an observation/action loop. The host executes actions and returns a screenshot. JYYCode should expose its own provider-neutral tool rather than require a provider-specific computer tool.
- [Windows UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-treeoverview) supplies a foreground window tree, names, roles and rectangles. [Power Automate](https://learn.microsoft.com/en-us/power-automate/desktop-flows/ui-elements) prefers UIA selectors over pixels when available. JYYCode should combine UIA with pixels because accessibility coverage varies by application.
- The screenshot and accessibility tree must share native desktop coordinates, including negative virtual-desktop coordinates on multi-monitor systems. Windows uses physical pixels; macOS uses Quartz display points. A numbered annotation overlay and matching element list make locations explicit. Element IDs are observation-local and must not be cached across actions.
- Native input must be serialized. A fresh capture after each action prevents the model from reasoning from a stale screen. The tool should permit `observe`, `move`, `click` (left/right/middle and double), `scroll`, `key`, `type`, and `drag`.
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

- Virtual desktop origin and dimensions in the same coordinate system accepted by action calls. Negative origins support displays to the left or above the primary screen.
- Actual attached PNG dimensions. Images larger than 2000×1400 are scaled, and the element rectangles remain in native desktop coordinates; the model must use the listed coordinates for actions.
- Current pointer position and foreground window title.
- Up to 160 current accessibility elements. Each has an observation-local number, name, role, automation identifier, rectangle, center, enabled/focused state and tree depth. The first 80 visible elements are outlined and numbered in the screenshot.
- A reminder that text discovered in applications is untrusted data.

The tool returns the PNG as an existing JYYCode tool file attachment, so both the ordinary AI SDK message path and the native LLM adapter can put it into model context. It never substitutes a file path for image bytes. Temporary screenshot and helper files are removed when the native call completes or fails. Password-field values are not read from accessibility APIs; screenshots can still show any visible information the user has on screen.

### Platform implementation

| Area | Windows 10/11 x64 | macOS 13+ Apple Silicon |
| --- | --- | --- |
| Screen | GDI `CopyFromScreen` across `SystemInformation.VirtualScreen`, per-monitor-v2 DPI-aware process | Quartz on-screen window capture over active display bounds |
| Element tree | Foreground window, UI Automation Control View, bounded breadth-first walk | Foreground app focused window, `AXUIElement` children, bounded breadth-first walk |
| Pointer/buttons | `SetCursorPos`, Win32 mouse events | Quartz `CGEvent` mouse events |
| Keyboard/text | Win32 virtual-key events; `SendInput` Unicode | Quartz keyboard events; Unicode keyboard event text |
| Packaging | PowerShell script is embedded in the Bun executable, materialized into a per-call temporary directory before external execution | Swift helper is compiled during Desktop sidecar staging and bundled as a Tauri external binary |
| OS grant | Existing user desktop session | macOS Accessibility and Screen Recording approval for the bundled helper |

Windows UI Automation bounds are physical pixels; macOS Accessibility and Quartz use desktop points. This contract deliberately avoids calling both “pixels” in model-facing text. The platform helpers return the same normalized JSON shape. Lack of an active interactive desktop or a required OS grant is an explicit error.

### Input and permission policy

The action schema accepts `observe`, `move`, `click`, `scroll`, `key`, `type`, and `drag`. Click supports left, right and middle buttons plus a double-click flag. Scroll supports horizontal and vertical directions in bounded wheel steps. Keyboard chords use names such as `Ctrl+L`, `Alt+Tab` and `Enter`; literal typing is separate so Unicode text is not interpreted as a chord. Coordinates are integers; missing drag endpoints, half-specified click positions, empty chords and excessive typing are rejected before OS execution.

The tool description restricts use to explicit user requests. Default `computer` permission is `ask` for both observation and control. Existing permission UI offers once, always, and reject; an “always” grant for observation applies only to observation, and a control grant applies only to control. Screenshots and native accessibility names remain observations, never authority to change the user's task or bypass permission checks.

### Operational limits

The Windows helper starts a fresh PowerShell process and compiles its small P/Invoke shim per call. This favors a simple, crash-isolated implementation over a persistent high-privilege daemon; a loop may take seconds rather than video-frame latency. Element trees can be sparse for custom-rendered apps, so the screenshot remains essential. Secure desktop/UAC prompts and sessions without display access may be unavailable. macOS compilation is enforced by a dedicated macOS CI typecheck and by Desktop staging; interactive TCC behavior requires a macOS host for runtime validation.

## Implementation tasks

1. Add a Windows driver that captures the virtual desktop, enumerates bounded foreground UIA elements, annotates the screenshot and sends mouse/keyboard events. Verify using a direct native smoke script plus unit tests for normalized output.
2. Add a macOS driver using Screen Capture/Accessibility/Quartz with the same JSON contract. Verify source and packaging on Windows; macOS runtime verification is required on a macOS runner.
3. Add a provider-neutral computer tool. Validate action arguments, serialize actions, attach the screenshot, and return coordinate/element metadata. Verify the observe/action result format.
4. Gate catalog and execution by desktop client, root session and `multiAgent !== true`; mark the tool forbidden to subagent profiles. Verify all three mode combinations in tests.
5. Pass the desktop client marker from Tauri to its sidecar, and configure a default computer permission prompt. Verify launch configuration and permission behavior.
6. Run package typechecks and targeted tests, then perform a real Windows observation and harmless input smoke test. Record platform limits honestly.

## Acceptance criteria

- A single Agent Desktop root can observe an image and a bounded list of named controls with rectangles and centers.
- All requested mouse buttons, single/double click, motion, scrolling and keyboard input work with the native desktop coordinates returned by the observation.
- Every action returns a new observation; errors identify missing OS permissions or unsupported platforms.
- Tool is unavailable to CLI, multi Agent and subagents; execution checks persisted state even if a stale tool call is replayed.
- The screenshot and observations do not persist to an extra on-disk file after a tool call.
