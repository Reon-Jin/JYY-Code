#!/usr/bin/env python3
"""Generate a literature-review PDF with host-discovered Pandoc and XeLaTeX."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def configure_console_encoding() -> None:
    """Avoid Windows legacy-console failures while preserving normal streams."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError):
                pass


def executable(name: str) -> str | None:
    return shutil.which(name)


def check_dependencies() -> bool:
    """Report the portable prerequisites without prescribing an installer."""
    missing: list[str] = []
    for name in ("pandoc", "xelatex"):
        resolved = executable(name)
        if resolved:
            print(f"[OK] {name}: {resolved}")
        else:
            print(f"[MISSING] {name}")
            missing.append(name)

    if missing:
        print("PDF export is unavailable on this host.")
        print("Use the host's approved package-management process, or return Markdown and report that PDF export was skipped.")
        return False
    return True


def generate_pdf(
    markdown_file: str,
    output_pdf: str | None = None,
    citation_style: str = "apa",
    template: str | None = None,
    toc: bool = True,
    number_sections: bool = True,
) -> bool:
    source = Path(markdown_file)
    if not source.is_file():
        print(f"Error: Markdown file not found: {source}")
        return False
    if not check_dependencies():
        return False

    pandoc = executable("pandoc")
    if not pandoc:
        return False
    destination = Path(output_pdf) if output_pdf else source.with_suffix(".pdf")
    cmd = [
        pandoc,
        str(source),
        "-o",
        str(destination),
        "--pdf-engine=xelatex",
        "-V",
        "geometry:margin=1in",
        "-V",
        "fontsize=11pt",
        "-V",
        "colorlinks=true",
        "-V",
        "linkcolor=blue",
        "-V",
        "urlcolor=blue",
        "-V",
        "citecolor=blue",
    ]
    if toc:
        cmd.extend(["--toc", "--toc-depth=3"])
    if number_sections:
        cmd.append("--number-sections")

    bibliography = source.with_suffix(".bib")
    if bibliography.exists():
        csl = citation_style if citation_style.endswith(".csl") else f"{citation_style}.csl"
        cmd.extend(["--citeproc", "--bibliography", str(bibliography), "--csl", csl])
    if template and Path(template).is_file():
        cmd.extend(["--template", template])

    print(f"Generating PDF: {destination}")
    try:
        subprocess.run(cmd, text=True, check=True)
    except subprocess.CalledProcessError as error:
        print(f"Error generating PDF (exit {error.returncode}).")
        return False
    print(f"[OK] PDF generated: {destination}")
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a PDF using host-discovered Pandoc and XeLaTeX.",
    )
    parser.add_argument("markdown_file", nargs="?", help="Input Markdown file")
    parser.add_argument("output_pdf", nargs="?", help="Output PDF path")
    parser.add_argument("--citation-style", default="apa")
    parser.add_argument("--template")
    parser.add_argument("--no-toc", action="store_true")
    parser.add_argument("--no-numbers", action="store_true")
    parser.add_argument("--check-deps", action="store_true")
    return parser.parse_args()


def main() -> int:
    configure_console_encoding()
    args = parse_args()
    if args.check_deps:
        return 0 if check_dependencies() else 1
    if not args.markdown_file:
        print("Error: markdown_file is required unless --check-deps is used.")
        return 2
    return int(
        not generate_pdf(
            args.markdown_file,
            args.output_pdf,
            citation_style=args.citation_style,
            template=args.template,
            toc=not args.no_toc,
            number_sections=not args.no_numbers,
        ),
    )


if __name__ == "__main__":
    raise SystemExit(main())
