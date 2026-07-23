#!/usr/bin/env python3
"""Inspect a PDF form and render coordinate-grid previews."""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="List AcroForm fields and render a coordinate grid for each PDF page."
    )
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--step", type=int, default=25, help="grid step in PDF points")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="replace an existing generated page grid",
    )
    return parser.parse_args()


def load_fitz():
    try:
        import fitz
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: PyMuPDF. With user consent, install the "
            "packages listed in the skill's requirements.txt."
        ) from exc
    return fitz


def validate_args(args: argparse.Namespace) -> None:
    if args.dpi < 72 or args.dpi > 600:
        raise SystemExit("--dpi must be between 72 and 600.")
    if args.step < 5 or args.step > 200:
        raise SystemExit("--step must be between 5 and 200 PDF points.")
    if not args.pdf.is_file():
        raise SystemExit(f"PDF not found or not a regular file: {args.pdf}")


def list_fields(document) -> list[tuple[int, str, str, tuple[float, ...]]]:
    fields = []
    for page_number in range(document.page_count):
        for widget in document[page_number].widgets() or []:
            fields.append(
                (
                    page_number,
                    widget.field_name or "",
                    widget.field_type_string or "unknown",
                    tuple(round(value, 1) for value in widget.rect),
                )
            )
    return fields


def draw_grid(fitz, document, step: int):
    grid = fitz.open()
    grid.insert_pdf(document)
    grey = (0.7, 0.7, 0.85)
    red = (0.9, 0.1, 0.1)

    for page_number in range(grid.page_count):
        page = grid[page_number]
        width, height = page.rect.width, page.rect.height

        x = 0
        while x <= width:
            major = int(x) % 100 == 0
            page.draw_line(
                (x, 0),
                (x, height),
                color=red if major else grey,
                width=0.5 if major else 0.25,
            )
            if major and x > 0:
                page.insert_text((x + 1, 9), str(int(x)), fontsize=6, color=red)
            x += step

        y = 0
        while y <= height:
            major = int(y) % 100 == 0
            page.draw_line(
                (0, y),
                (width, y),
                color=red if major else grey,
                width=0.5 if major else 0.25,
            )
            if major and y > 0:
                page.insert_text((2, y - 1), str(int(y)), fontsize=6, color=red)
            y += step

    return grid


def main() -> None:
    args = parse_args()
    validate_args(args)
    fitz = load_fitz()

    try:
        document = fitz.open(args.pdf)
    except Exception as exc:
        raise SystemExit(f"Could not open PDF: {exc}") from exc

    try:
        if document.page_count < 1:
            raise SystemExit("The PDF has no pages.")
        if document.needs_pass:
            raise SystemExit("The PDF is encrypted. Decrypt an authorised working copy first.")

        first = document[0].rect
        print(f"PDF: {args.pdf}")
        print(
            f"Pages: {document.page_count} | first page: "
            f"{first.width:.0f} x {first.height:.0f} pt"
        )

        fields = list_fields(document)
        if fields:
            print(f"\nFillable PDF: {len(fields)} AcroForm fields")
            print(f"{'page':>4}  {'type':<14} name")
            for page_number, name, field_type, rect in fields:
                print(
                    f"{page_number:>4}  {field_type:<14} "
                    f"{name!r} rect={rect}"
                )
        else:
            print("\nFlat PDF: no AcroForm fields. Use coordinate overlays.")

        output_unresolved = (
            args.output_dir.expanduser()
            if args.output_dir
            else args.pdf.resolve().with_suffix("").with_name(
                f"{args.pdf.stem}_grid"
            )
        )
        if output_unresolved.is_symlink():
            raise SystemExit("Grid output directory must not be a symbolic link.")
        output_dir = output_unresolved.resolve()
        if output_dir.exists() and not output_dir.is_dir():
            raise SystemExit(f"Grid output target is not a directory: {output_dir}")
        if output_dir.exists():
            safe = re.compile(r"^page-[1-9][0-9]*\.png$")
            entries = list(output_dir.iterdir())
            if any(
                entry.is_symlink()
                or not entry.is_file()
                or safe.fullmatch(entry.name) is None
                for entry in entries
            ):
                raise SystemExit(
                    "Grid output directory contains unexpected files; "
                    "choose another --output-dir."
                )
            if entries and not args.overwrite:
                raise SystemExit(
                    "Grid output already exists. Use --overwrite for an "
                    "intentional revision."
                )
            for entry in entries:
                entry.unlink()
        output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(output_dir, 0o700)

        grid = draw_grid(fitz, document, args.step)
        try:
            for page_number in range(grid.page_count):
                target = output_dir / f"page-{page_number + 1}.png"
                grid[page_number].get_pixmap(dpi=args.dpi).save(target)
                os.chmod(target, 0o600)
        finally:
            grid.close()

        print(f"\nCoordinate grids: {output_dir}/page-*.png")
        print("Review the PNG files before choosing overlay coordinates.")
    finally:
        document.close()


if __name__ == "__main__":
    main()
