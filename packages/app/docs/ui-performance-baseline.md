# Desktop UI performance baseline

The desktop app records aggregate, content-free measurements for startup bootstrap, workspace chunk readiness, first workspace shell, first conversation paint, and first file preview readiness. In development it prints one `[jyycode/ui-performance]` summary; production samples the summary at a low rate.

The summary also tracks streaming render count, long-task p95 when the browser exposes `PerformanceObserver`, and heap usage when the webview exposes `performance.memory`. It never includes message text, session identifiers, project paths, or request payloads.

After a UI performance change, run:

```text
bun run --cwd packages/app test
bun run --cwd packages/app typecheck
bun run --cwd packages/app build
bun run --cwd packages/app budget
```

`budget` writes `packages/app/dist/performance-summary.json`. Initial assets are classified from `dist/index.html`; workspace, file-preview, PDF worker, PPTX, and other lazy chunks are reported separately so a large on-demand viewer cannot silently inflate the startup budget.

Record before/after values for first interactive time, startup request count, streaming render count, long-task p95, long-session heap usage, and the generated asset summary in the pull request when a change affects those paths.
