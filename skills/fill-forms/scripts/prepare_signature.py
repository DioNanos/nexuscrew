#!/usr/bin/env python3
"""Prepare an explicitly authorised local signature image for PDF overlay."""

from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Remove paper background, crop and export a signature as transparent PNG. "
            "Use only with the signer's explicit authorisation."
        )
    )
    parser.add_argument("src", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--dark", type=int, default=90)
    parser.add_argument("--light", type=int, default=185)
    parser.add_argument("--margin", type=int, default=12)
    parser.add_argument(
        "--min-alpha",
        type=int,
        default=60,
        help="discard low-opacity background pixels; 0 disables",
    )
    parser.add_argument(
        "--max-width",
        type=int,
        default=0,
        help="downsize to this pixel width; 0 preserves the cropped width",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="replace an existing output file, never the source",
    )
    return parser.parse_args()


def load_dependencies():
    try:
        import numpy
        from PIL import Image
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: numpy and Pillow are required. With user "
            "consent, install the packages listed in requirements.txt."
        ) from exc
    return numpy, Image


def validate_args(args: argparse.Namespace) -> tuple[Path, Path]:
    source = args.src.resolve()
    output_unresolved = args.out.expanduser()
    if output_unresolved.is_symlink():
        raise SystemExit("Output must not be a symbolic link.")
    output = output_unresolved.resolve()

    if not source.is_file():
        raise SystemExit(f"Input image not found or not a regular file: {source}")
    if source == output:
        raise SystemExit("Source and output must be different files.")
    if output.exists() and not args.overwrite:
        raise SystemExit("Output already exists. Use --overwrite for an intentional revision.")
    if output.suffix.lower() != ".png":
        raise SystemExit("Output must use the .png extension.")
    if not 0 <= args.dark < args.light <= 255:
        raise SystemExit("Require 0 <= --dark < --light <= 255.")
    if args.margin < 0 or args.margin > 1000:
        raise SystemExit("--margin must be between 0 and 1000 pixels.")
    if not 0 <= args.min_alpha <= 255:
        raise SystemExit("--min-alpha must be between 0 and 255.")
    if args.max_width < 0 or args.max_width > 20_000:
        raise SystemExit("--max-width must be between 0 and 20000 pixels.")
    return source, output


def flatten_to_greyscale(Image, source):
    if source.mode in ("RGBA", "LA") or (
        source.mode == "P" and "transparency" in source.info
    ):
        rgba = source.convert("RGBA")
        flattened = Image.new("RGB", rgba.size, (255, 255, 255))
        flattened.paste(rgba, mask=rgba.getchannel("A"))
        return flattened.convert("L")
    return source.convert("L")


def main() -> None:
    args = parse_args()
    source_path, output_path = validate_args(args)
    np, Image = load_dependencies()

    try:
        with Image.open(source_path) as source:
            source.load()
            grey = np.asarray(flatten_to_greyscale(Image, source), dtype=np.float32)
    except Exception as exc:
        raise SystemExit(f"Could not read input image: {exc}") from exc

    dark = float(args.dark)
    light = float(args.light)
    alpha = np.clip((light - grey) / (light - dark), 0.0, 1.0)

    ink = alpha > 0.35
    height, width = ink.shape
    column_ink = ink.sum(axis=0)
    row_ink = ink.sum(axis=1)
    minimum_column = max(3, int(0.004 * height))
    minimum_row = max(3, int(0.004 * width))
    columns = np.where(column_ink >= minimum_column)[0]
    rows = np.where(row_ink >= minimum_row)[0]
    if columns.size == 0 or rows.size == 0:
        raise SystemExit(
            "No consistent ink stroke detected. Adjust --dark/--light and inspect the source."
        )

    margin = args.margin
    x0 = max(0, int(columns[0]) - margin)
    x1 = min(width, int(columns[-1]) + 1 + margin)
    y0 = max(0, int(rows[0]) - margin)
    y1 = min(height, int(rows[-1]) + 1 + margin)

    cropped_alpha = (alpha[y0:y1, x0:x1] * 255).astype(np.uint8)
    if args.min_alpha:
        cropped_alpha[cropped_alpha < args.min_alpha] = 0

    crop_height, crop_width = cropped_alpha.shape
    pixels = np.zeros((crop_height, crop_width, 4), dtype=np.uint8)
    pixels[..., 3] = cropped_alpha
    prepared = Image.fromarray(pixels, "RGBA")

    if args.max_width and crop_width > args.max_width:
        new_height = max(1, round(crop_height * args.max_width / crop_width))
        prepared = prepared.resize(
            (args.max_width, new_height),
            Image.Resampling.LANCZOS,
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        prefix=f".{output_path.name}.",
        suffix=".tmp",
        dir=output_path.parent,
        delete=False,
    )
    temporary = Path(handle.name)
    handle.close()
    try:
        prepared.save(temporary, format="PNG")
        os.replace(temporary, output_path)
        os.chmod(output_path, 0o600)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    print(
        f"Saved: {output_path} | crop {prepared.width}x{prepared.height}px "
        f"from {width}x{height}px"
    )
    print(
        "Verify the PNG on a pure white background. Keep it private and use it "
        "only for the specifically authorised document."
    )


if __name__ == "__main__":
    main()
