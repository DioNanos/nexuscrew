#!/usr/bin/env python3
"""Fill a local PDF with AcroForm values and/or coordinate overlays."""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import tempfile
from pathlib import Path

MAX_CONFIG_BYTES = 2 * 1024 * 1024
MAX_IMAGE_BYTES = 25 * 1024 * 1024
BLACK = (0, 0, 0)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fill a PDF from a bounded JSON configuration and render previews."
    )
    parser.add_argument("config", type=Path)
    parser.add_argument("--dpi", type=int, default=130)
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="replace an existing output file, never the source",
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


def load_pillow_image():
    try:
        from PIL import Image
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: Pillow is required for image overlays. With "
            "user consent, install the packages listed in requirements.txt."
        ) from exc
    return Image


def read_config(path: Path) -> dict:
    if not path.is_file():
        raise SystemExit(f"Configuration not found: {path}")
    if path.stat().st_size > MAX_CONFIG_BYTES:
        raise SystemExit("Configuration exceeds the 2 MiB safety limit.")
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Could not read configuration: {exc}") from exc
    if not isinstance(config, dict):
        raise SystemExit("Configuration must be a JSON object.")
    return config


def resolve_path(base: Path, value, label: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise SystemExit(f"{label} must be a non-empty path string.")
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def number(value, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SystemExit(f"{label} must be numeric.")
    return float(value)


def positive_size(value, label: str) -> float:
    size = number(value, label)
    if size <= 0 or size > 72:
        raise SystemExit(f"{label} must be greater than 0 and at most 72.")
    return size


def point(item: dict, page, index: int) -> tuple[float, float]:
    x = number(item.get("x"), f"overlay[{index}].x")
    y = number(item.get("y"), f"overlay[{index}].y")
    if x < 0 or x > page.rect.width or y < 0 or y > page.rect.height:
        raise SystemExit(f"overlay[{index}] coordinates fall outside the page.")
    return x, y


def register_font(page, font_file: Path | None) -> str:
    if font_file is None:
        return "helv"
    page.insert_font(fontname="formfill", fontfile=str(font_file))
    return "formfill"


def apply_acroform(fitz, document, data: dict) -> int:
    if not isinstance(data, dict) or not data:
        raise SystemExit("acroform must be a non-empty object.")

    requested = set()
    for key, value in data.items():
        if not isinstance(key, str) or not key:
            raise SystemExit("Every AcroForm field name must be a non-empty string.")
        if not isinstance(value, (str, int, float, bool)) and value is not None:
            raise SystemExit(f"AcroForm field {key!r} has a non-scalar value.")
        requested.add(key)

    seen = set()
    updates = 0
    for page_number in range(document.page_count):
        for widget in document[page_number].widgets() or []:
            if widget.field_name not in data:
                continue
            value = data[widget.field_name]
            if widget.field_type == fitz.PDF_WIDGET_TYPE_CHECKBOX:
                widget.field_value = bool(value)
            else:
                widget.field_value = "" if value is None else str(value)
            widget.update()
            seen.add(widget.field_name)
            updates += 1

    missing = sorted(requested - seen)
    if missing:
        raise SystemExit(
            "Unknown AcroForm fields: " + ", ".join(repr(name) for name in missing)
        )
    return updates


def validate_rect(fitz, values, page, index: int):
    if not isinstance(values, list) or len(values) != 4:
        raise SystemExit(f"overlay[{index}].rect must contain four numbers.")
    rect = fitz.Rect(*(number(value, f"overlay[{index}].rect") for value in values))
    if rect.is_empty or rect.is_infinite:
        raise SystemExit(f"overlay[{index}].rect must be a finite non-empty rectangle.")
    page_rect = page.rect
    if (
        rect.x0 < page_rect.x0
        or rect.y0 < page_rect.y0
        or rect.x1 > page_rect.x1
        or rect.y1 > page_rect.y1
    ):
        raise SystemExit(f"overlay[{index}].rect falls outside the page.")
    return rect


def image_stream(Image, image_path: Path, rect) -> bytes:
    if not image_path.is_file():
        raise SystemExit(f"Overlay image not found: {image_path}")
    if image_path.stat().st_size > MAX_IMAGE_BYTES:
        raise SystemExit(f"Overlay image exceeds the 25 MiB safety limit: {image_path}")
    try:
        with Image.open(image_path) as image:
            image.load()
            max_width = max(64, int(rect.width / 72 * 250))
            if image.width > max_width:
                new_height = max(1, round(image.height * max_width / image.width))
                image = image.resize((max_width, new_height), Image.Resampling.LANCZOS)
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            return buffer.getvalue()
    except Exception as exc:
        raise SystemExit(f"Could not prepare overlay image {image_path}: {exc}") from exc


def apply_overlays(fitz, document, items, default_size, base, font_file) -> int:
    if not isinstance(items, list) or not items:
        raise SystemExit("overlay must be a non-empty array.")

    pillow_image = None
    applied = 0
    total_text = 0

    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise SystemExit(f"overlay[{index}] must be an object.")
        page_number = item.get("page")
        if (
            isinstance(page_number, bool)
            or not isinstance(page_number, int)
            or page_number < 0
            or page_number >= document.page_count
        ):
            raise SystemExit(f"overlay[{index}].page is outside the document.")
        page = document[page_number]

        is_image = "image" in item
        is_check = item.get("check") is True
        is_text = "text" in item
        if sum((is_image, is_check, is_text)) != 1:
            raise SystemExit(
                f"overlay[{index}] must contain exactly one of image, check:true or text."
            )

        if is_image:
            rect = validate_rect(fitz, item.get("rect"), page, index)
            image_path = resolve_path(base, item["image"], f"overlay[{index}].image")
            if pillow_image is None:
                pillow_image = load_pillow_image()
            stream = image_stream(pillow_image, image_path, rect)
            stretch = item.get("stretch", False)
            if not isinstance(stretch, bool):
                raise SystemExit(f"overlay[{index}].stretch must be true or false.")
            page.insert_image(rect, stream=stream, keep_proportion=not stretch)
            applied += 1
            continue

        x, y = point(item, page, index)
        if is_check:
            size = positive_size(item.get("size", 11), f"overlay[{index}].size")
            font_name = register_font(page, font_file)
            page.insert_text((x, y), "X", fontsize=size, fontname=font_name, color=BLACK)
            applied += 1
            continue

        text = item["text"]
        if not isinstance(text, (str, int, float)) or isinstance(text, bool):
            raise SystemExit(f"overlay[{index}].text must be a string or number.")
        text = str(text)
        if len(text) > 5000:
            raise SystemExit(f"overlay[{index}].text exceeds 5000 characters.")
        total_text += len(text)
        if total_text > 100_000:
            raise SystemExit("Overlay text exceeds the 100000-character safety limit.")
        size = positive_size(item.get("size", default_size), f"overlay[{index}].size")
        font_name = register_font(page, font_file)
        spread = item.get("spread")

        if spread is None:
            page.insert_text(
                (x, y),
                text,
                fontsize=size,
                fontname=font_name,
                color=BLACK,
            )
        else:
            if not isinstance(spread, dict):
                raise SystemExit(f"overlay[{index}].spread must be an object.")
            step = number(spread.get("step"), f"overlay[{index}].spread.step")
            if step <= 0 or step > 200:
                raise SystemExit(
                    f"overlay[{index}].spread.step must be greater than 0 and at most 200."
                )
            skip_values = spread.get("skip", [])
            if (
                not isinstance(skip_values, list)
                or any(
                    isinstance(value, bool)
                    or not isinstance(value, int)
                    or value < 0
                    for value in skip_values
                )
            ):
                raise SystemExit(
                    f"overlay[{index}].spread.skip must contain non-negative integers."
                )
            skip = set(skip_values)
            for character_index, character in enumerate(text):
                if character_index not in skip:
                    page.insert_text(
                        (x, y),
                        character,
                        fontsize=size,
                        fontname=font_name,
                        color=BLACK,
                    )
                x += step
        applied += 1

    return applied


def save_atomic(document, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        prefix=f".{output.name}.",
        suffix=".tmp",
        dir=output.parent,
        delete=False,
    )
    temporary = Path(handle.name)
    handle.close()
    try:
        document.save(temporary, garbage=4, deflate=True)
        os.replace(temporary, output)
        os.chmod(output, 0o600)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def preview_path(output: Path) -> Path:
    return output.with_suffix("").with_name(f"{output.stem}_preview")


def validate_preview_target(preview_dir: Path, overwrite: bool) -> None:
    if preview_dir.is_symlink():
        raise SystemExit("Preview directory must not be a symbolic link.")
    if not preview_dir.exists():
        return
    if not preview_dir.is_dir():
        raise SystemExit(f"Preview target is not a directory: {preview_dir}")
    entries = list(preview_dir.iterdir())
    safe = re.compile(r"^page-[1-9][0-9]*\.png$")
    if any(
        entry.is_symlink()
        or not entry.is_file()
        or safe.fullmatch(entry.name) is None
        for entry in entries
    ):
        raise SystemExit(
            "Preview directory contains unexpected files; choose another output name."
        )
    if entries and not overwrite:
        raise SystemExit(
            "Preview directory already exists. Use --overwrite for an intentional revision."
        )


def render_previews(fitz, output: Path, preview_dir: Path, dpi: int) -> Path:
    preview_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(preview_dir, 0o700)
    for existing in preview_dir.glob("page-*.png"):
        existing.unlink()
    completed = fitz.open(output)
    try:
        for page_number in range(completed.page_count):
            target = preview_dir / f"page-{page_number + 1}.png"
            completed[page_number].get_pixmap(dpi=dpi).save(target)
            os.chmod(target, 0o600)
    finally:
        completed.close()
    return preview_dir


def main() -> None:
    args = parse_args()
    if args.dpi < 72 or args.dpi > 600:
        raise SystemExit("--dpi must be between 72 and 600.")

    config_path = args.config.resolve()
    config = read_config(config_path)
    base = config_path.parent
    source = resolve_path(base, config.get("src"), "src")
    output_value = config.get("out")
    output_unresolved = Path(output_value).expanduser() if isinstance(output_value, str) else None
    if output_unresolved is not None and not output_unresolved.is_absolute():
        output_unresolved = base / output_unresolved
    if output_unresolved is not None and output_unresolved.is_symlink():
        raise SystemExit("Output must not be a symbolic link.")
    output = resolve_path(base, output_value, "out")

    if not source.is_file():
        raise SystemExit(f"Source PDF not found or not a regular file: {source}")
    if source == output:
        raise SystemExit("Source and output must be different files.")
    if output.exists() and not args.overwrite:
        raise SystemExit("Output already exists. Use --overwrite for an intentional revision.")
    preview_dir = preview_path(output)
    validate_preview_target(preview_dir, args.overwrite)

    mode = config.get("mode", "overlay")
    if mode not in {"acroform", "overlay", "both"}:
        raise SystemExit("mode must be acroform, overlay or both.")
    default_size = positive_size(config.get("font_size", 9), "font_size")

    font_file = None
    if config.get("font_file") is not None:
        font_file = resolve_path(base, config["font_file"], "font_file")
        if not font_file.is_file() or font_file.suffix.lower() not in {".ttf", ".otf"}:
            raise SystemExit("font_file must be an existing local TTF or OTF file.")

    fitz = load_fitz()
    try:
        document = fitz.open(source)
    except Exception as exc:
        raise SystemExit(f"Could not open source PDF: {exc}") from exc

    try:
        if document.page_count < 1:
            raise SystemExit("The PDF has no pages.")
        if document.needs_pass:
            raise SystemExit("The PDF is encrypted. Decrypt an authorised working copy first.")

        acroform_count = 0
        overlay_count = 0
        if mode in {"acroform", "both"}:
            acroform_count = apply_acroform(fitz, document, config.get("acroform"))
        if mode in {"overlay", "both"}:
            overlay_count = apply_overlays(
                fitz,
                document,
                config.get("overlay"),
                default_size,
                base,
                font_file,
            )
        save_atomic(document, output)
    finally:
        document.close()

    preview_dir = render_previews(fitz, output, preview_dir, args.dpi)
    print(
        f"Saved: {output} "
        f"(AcroForm updates: {acroform_count}, overlays: {overlay_count})"
    )
    print(f"Verification previews: {preview_dir}/page-*.png")
    print("Review every page before handoff, signing, sending or submission.")


if __name__ == "__main__":
    main()
