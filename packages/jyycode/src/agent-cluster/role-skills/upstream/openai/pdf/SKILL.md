---
name: "pdf"
description: "Read, create, inspect, render, and verify PDF files with a Windows-compatible runtime workflow."
---

# PDF Skill

## When to use

- Read or review PDF content where layout and visuals matter.
- Create PDFs programmatically with reliable formatting.
- Validate final rendering before delivery.

## Runtime contract

- Use the workspace-provided runtime and already-installed tools first. Do not install packages or system tools during a task.
- Do not assume python3, Homebrew, apt, sudo, or a Unix shell is available.
- On Windows, discover optional executables before using them:

      $pdftoppm = (Get-Command pdftoppm -ErrorAction SilentlyContinue).Source
      $pdfinfo = (Get-Command pdfinfo -ErrorAction SilentlyContinue).Source
      $soffice = (Get-Command soffice -ErrorAction SilentlyContinue).Source

- Invoke a discovered executable path with the PowerShell call operator:

      & $pdftoppm -png -- $InputPdf $OutputPrefix

- If the workspace resolves a Python runtime, use that runtime and its installed libraries. Otherwise use python only when it is already available. Do not prescribe package-install commands.

## Workflow

1. Inspect the input PDF and confirm the requested edit, output path, and whether visual fidelity is required.
2. Use reportlab for new PDFs when it is already available in the assigned runtime.
3. Use pdfplumber or pypdf for extraction and structural checks when available; do not treat extraction as layout verification.
4. Render the final PDF to PNGs with a discovered Poppler renderer and inspect alignment, spacing, legibility, links, tables, and glyphs.
5. If no renderer is available, perform structural checks and clearly report that visual QA was unavailable. Never state that an unrendered file is print-ready.

## Rendering fallbacks

1. Prefer a discovered pdftoppm executable.
2. If the source is an Office document and a discovered soffice executable is available, use its headless conversion only when the task requires a PDF export; then render the produced PDF if pdftoppm is available.
3. Without a renderer, verify page count, readable extracted text, metadata, links, and file integrity with available libraries, then disclose the visual-QA limitation.

## Temp and output conventions

- Use tmp/pdfs/ for intermediate files when that convention fits the repository.
- Write final artifacts to the task-requested path; do not override an existing project convention.
- Keep source files, intermediate files, and final outputs separate.

## Quality expectations

- Maintain consistent typography, spacing, margins, headers, footers, and section hierarchy.
- Avoid clipped text, overlapping elements, broken tables, black squares, and unreadable glyphs.
- Keep charts, tables, and images sharp, aligned, and clearly labeled.
- Ensure citations and references are human-readable with no tool tokens or placeholders.

## Final checks

- Report the output path and the exact structural and visual checks completed.
- State every unavailable check or unresolved layout issue.
- Keep intermediate files organized or remove only files created for the task after final approval.
