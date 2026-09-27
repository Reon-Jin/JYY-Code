# Computer resource lifecycle and positioning regression

The reported source-build workload was playing Slay the Spire and drawing in Paint. The supplied Task Manager image
shows the JYYCode WebView2 renderer at 6,238.6 MB, with 2.1% aggregate WebView CPU at that instant. No live heap snapshot
of that incident was available, so the exact composition of those 6 GB cannot be established from the image alone.

## Confirmed defects and fixes

1. The desktop reducer accepted every screenshot attachment from history and SSE without its own memory budget.
   Server-side screenshot pruning depended on maintenance and delivery of subsequent update events. Missing those
   events left every image referenced indefinitely in the active query. `loadConversation` also preferred the entire
   cached snapshot merely because a tool with the same ID existed; a refetch could therefore fail to retire screenshots.
   The reducer now limits computer images to three and 16 MiB of estimated UTF-16 URL storage per conversation. The
   refetch merges individual parts, accepts authoritative cleanup, and preserves concurrent stream progress. Inactive
   conversation queries use a 60-second GC interval once configured by their observer. User uploads and text remain.
2. The timeline inferred pending animation from the absence of subsequent final text, without consulting session status.
   An interrupted computer task could keep drawing its canvas animation. The workspace now supplies busy/retry status,
   which gates both activity and goal animation.
3. Windows PowerShell, OmniParser, and OCR workers were process-wide and were not released at session completion.
   Detached vision/OCR warmup was especially problematic: `close()` only checked an already-started worker, allowing
   an in-progress startup to finish after cancellation. Session run-state now invokes an idempotent cleanup hook. The
   last computer session releases shared workers, including pending startup, and every worker has a 30-second idle
   timeout. Cleanup failure is logged without breaking cancellation. The hook captures only session IDs, not histories.
4. Legacy pointer actions could omit frame identity and use the newest mapping even when their coordinates were chosen
   from an older image. Every pointer action now requires the latest `frameID`, including batches and element IDs.
   Jev fusion discarded UIA clickable points and substituted rectangle centers; these points now survive candidate
   generation. Partly offscreen element fallbacks use the visible intersection, and raw-to-desktop mapping clamps the
   final Retina pixel inside the desktop. Tool instructions distinguish image pixels from normalized/DPI coordinates
   and direct small game targets and precise drawing work through the existing raw-pixel zoom path.

## Verification

- Actual Chromium renderer, actual conversation reducer, 600 sequential tool results with distinct 256 KiB inline image
  strings and no server prune events. Explicit GC measures retained JavaScript heap, not whole-process working set:

  | Results | Baseline `1cbbcc47` screenshots / heap | Fixed screenshots / heap |
  | --- | --- | --- |
  | 100 | 100 / 26,750,696 bytes | 3 / 1,397,628 bytes |
  | 300 | 300 / 79,367,760 bytes | 3 / 1,491,636 bytes |
  | 600 | 600 / 158,162,472 bytes | 3 / 1,594,496 bytes |

  Reproduce from `packages/app`: `bun scripts/check-computer-memory.ts --baseline=1cbbcc47`.
  It uses an isolated headless Edge profile and closes its own browser. Set `JYYCODE_CHROMIUM` for another Chromium binary.
  Screenshots are synthetic transport payloads; this test does not claim a full application working-set ceiling.
- Windows native smoke test on this machine: physical 2560×1600, 150% DPI, image 1280×800. Requested image points
  `(256,160)`, `(640,400)`, `(1024,640)` arrived at physical `(512,320)`, `(1280,800)`, `(2048,1280)` exactly. Raw zoom center
  also arrived at `(1280,800)`. No clicks were sent; the pointer was restored and helper/frame temporary directories were
  removed. Opt in with `JYYCODE_COMPUTER_NATIVE_TEST=1` and run `test/tool/computer-native.windows.test.ts`.
- Regression suites cover snapshot and event retention, oversized images, authoritative pruning, stop-animation teardown,
  cancellation during actual Python warmup, idle child exit, stale frames, clipping, Retina edges, and Jev clickable points.
  Final runs: 89 frontend tests, 60 backend computer tests, two session lifecycle tests, and one opt-in native test passed.
  App/backend typechecks, the frontend production build, architecture verification and `git diff --check` passed.
  Lint reported zero errors; the changed-file run also includes existing type/assertion warnings and test-fixture casts.

## Remaining limits

This fixes demonstrated unbounded image retention and worker/animation lifecycle defects. It cannot guarantee that every
source of application memory always stays below a fixed process total. A model can still identify the wrong target in a
game, and a UI can change after capture and before input. Existing zoom/Jev target guards reduce that race; frame identity
alone detects a superseded observation, not every change inside the same window. These changes have not been evaluated
as an end-to-end Slay the Spire playing or Paint drawing success-rate benchmark, nor on physical mixed-DPI monitors.

The approach retains local cropping instead of adding another resident model. Primary references checked for this task:
[ZoomClick](https://github.com/Princeton-AI2-Lab/ZoomClick) and Microsoft's
[UI Automation clickable point](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.trygetclickablepoint).
Their published capabilities are not treated as a measured JYYCode click hit rate.
