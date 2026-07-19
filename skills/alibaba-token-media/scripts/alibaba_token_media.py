#!/usr/bin/env python3
"""Safe multi-client CLI for Alibaba Token Plan media generation.

The script is dependency-free and can be invoked by Claude Code, Codex,
Codex-VL, or Pi. Credentials are read only from ALIBABA_CODE_API_KEY and are
never printed or persisted.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
import fcntl
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
from typing import Any, Iterator
import urllib.error
import urllib.parse
import urllib.request


HOST = "https://token-plan.ap-southeast-1.maas.aliyuncs.com"
IMAGE_URL = HOST + "/api/v1/services/aigc/multimodal-generation/generation"
VIDEO_URL = HOST + "/api/v1/services/aigc/video-generation/video-synthesis"
TASK_URL = HOST + "/api/v1/tasks/{task_id}"
KEY_ENV = "ALIBABA_CODE_API_KEY"

IMAGE_MODELS = ("wan2.7-image", "wan2.7-image-pro")
VIDEO_MODELS = ("happyhorse-1.1-t2v", "happyhorse-1.1-i2v")
VIDEO_RATIOS = ("16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9")
IMAGE_MIME = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
}
I2V_MIME = {key: value for key, value in IMAGE_MIME.items() if key != ".bmp"}
MAX_INPUT_BYTES = 20 * 1024 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_IMAGE_DOWNLOAD = 64 * 1024 * 1024
MAX_VIDEO_DOWNLOAD = 1024 * 1024 * 1024
TASK_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


class UsageError(RuntimeError):
    """A safe, user-actionable validation error."""


def _emit(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def _require_key() -> str:
    key = os.environ.get(KEY_ENV, "")
    if not key:
        raise UsageError(f"{KEY_ENV} is not set in this process environment")
    if any(char.isspace() for char in key):
        raise UsageError(f"{KEY_ENV} contains whitespace and was rejected")
    return key


def _weighted_prompt_length(prompt: str) -> int:
    # HappyHorse documents 5,000 non-Chinese or 2,500 Chinese characters.
    return sum(2 if "\u3400" <= char <= "\u9fff" else 1 for char in prompt)


def _validate_prompt(prompt: str, *, video: bool = False, optional: bool = False) -> str:
    prompt = prompt.strip()
    if not prompt and not optional:
        raise UsageError("prompt must not be empty")
    if video:
        if _weighted_prompt_length(prompt) > 5000:
            raise UsageError("video prompt exceeds the documented weighted limit")
    elif len(prompt) > 5000:
        raise UsageError("image prompt exceeds 5,000 characters")
    return prompt


def _inside_home(path: Path) -> bool:
    home = Path.home().resolve()
    try:
        path.relative_to(home)
        return True
    except ValueError:
        return False


def _reject_symlink_components(path: Path) -> None:
    absolute = path.expanduser().absolute()
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current = current / part
        if current.is_symlink():
            raise UsageError(f"symlink input path rejected: {path}")


@contextlib.contextmanager
def _submit_lock() -> Iterator[None]:
    """Permit one generation POST per local user across CLI processes."""
    directory = Path.home() / ".cache" / "alibaba-token-media"
    _reject_symlink_components(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = directory.resolve(strict=True)
    if not _inside_home(directory):
        raise UsageError("submit lock directory escaped the current user's home")
    os.chmod(directory, 0o700)
    lock_path = directory / "submit.lock"
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        fd = os.open(lock_path, flags, 0o600)
    except OSError as exc:
        raise UsageError(f"cannot open private submit lock: {exc}") from None
    locked = False
    try:
        os.fchmod(fd, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except BlockingIOError:
            raise UsageError("another media generation submit is already in progress") from None
        yield
    finally:
        if locked:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _detect_image_mime(path: Path, allowed: dict[str, str]) -> str:
    suffix = path.suffix.lower()
    mime = allowed.get(suffix)
    if not mime:
        raise UsageError(f"unsupported image extension: {suffix or '[none]'}")
    with path.open("rb") as handle:
        head = handle.read(16)
    valid = {
        "image/jpeg": head.startswith(b"\xff\xd8\xff"),
        "image/png": head.startswith(b"\x89PNG\r\n\x1a\n"),
        "image/bmp": head.startswith(b"BM"),
        "image/webp": head.startswith(b"RIFF") and head[8:12] == b"WEBP",
    }[mime]
    if not valid:
        raise UsageError(f"file signature does not match {suffix}: {path}")
    return mime


def _local_image_data(raw: str, *, i2v: bool = False) -> str:
    supplied = Path(raw).expanduser()
    _reject_symlink_components(supplied)
    path = supplied.resolve(strict=True)
    if not _inside_home(path):
        raise UsageError("local image must be under the current user's home")
    if not path.is_file():
        raise UsageError(f"local image is not a regular file: {path}")
    size = path.stat().st_size
    if size <= 0 or size > MAX_INPUT_BYTES:
        raise UsageError("local image must be between 1 byte and 20 MiB")
    mime = _detect_image_mime(path, I2V_MIME if i2v else IMAGE_MIME)
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _public_https_url(raw: str) -> str:
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme != "https" or not parsed.hostname:
        raise UsageError("remote image must use a public HTTPS URL")
    if parsed.username or parsed.password or parsed.port not in (None, 443):
        raise UsageError("remote image URL contains forbidden authority fields")
    host = parsed.hostname.rstrip(".").lower()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise UsageError("local or internal remote-image host rejected")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address and not address.is_global:
        raise UsageError("non-public remote-image IP rejected")
    return raw


def _image_value(raw: str, *, i2v: bool = False) -> str:
    if raw.startswith(("http://", "https://")):
        return _public_https_url(raw)
    return _local_image_data(raw, i2v=i2v)


def _safe_payload(payload: dict[str, Any]) -> dict[str, Any]:
    clone = json.loads(json.dumps(payload))
    content = clone.get("input", {}).get("messages", [{}])[0].get("content", [])
    for item in content:
        if "image" in item:
            item["image"] = "[image input omitted]"
    for item in clone.get("input", {}).get("media", []):
        if "url" in item:
            item["url"] = "[first-frame input omitted]"
    return clone


def _request_json(
    url: str,
    *,
    key: str,
    payload: dict[str, Any] | None = None,
    asynchronous: bool = False,
) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "User-Agent": "nexuscrew-alibaba-token-media-skill/1",
    }
    data = None
    method = "GET"
    if payload is not None:
        method = "POST"
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    if asynchronous:
        headers["X-DashScope-Async"] = "enable"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            final = urllib.parse.urlsplit(response.geturl())
            expected = urllib.parse.urlsplit(url)
            if final.scheme != "https" or final.hostname != expected.hostname:
                raise UsageError("provider endpoint redirected outside its fixed HTTPS host")
            body = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        # Provider bodies can echo request fields or signed URLs. Keep errors
        # intentionally content-free so secrets and ephemeral URLs never leak.
        exc.read(MAX_RESPONSE_BYTES + 1)
        raise UsageError(f"provider HTTP {exc.code}; response body omitted") from None
    except urllib.error.URLError as exc:
        raise UsageError(f"provider connection failed: {exc.reason}") from None
    if len(body) > MAX_RESPONSE_BYTES:
        raise UsageError("provider response exceeded 2 MiB")
    try:
        result = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise UsageError("provider returned an invalid JSON response") from None
    if not isinstance(result, dict):
        raise UsageError("provider returned a non-object JSON response")
    return result


def _output_directory() -> Path:
    date = dt.datetime.now().astimezone().date().isoformat()
    return Path.home() / "Downloads" / "alibaba-token-plan" / date


def _validate_output(raw: str | None) -> Path | None:
    if raw is None:
        return None
    supplied = Path(raw).expanduser().absolute()
    _reject_symlink_components(supplied)
    if not _inside_home(supplied.resolve(strict=False)):
        raise UsageError("output path must remain under the current user's home")
    if supplied.exists():
        raise UsageError("output path already exists; overwrite is forbidden")
    parent = supplied.parent.resolve(strict=True)
    if not _inside_home(parent):
        raise UsageError("output parent must remain under the current user's home")
    return supplied


def _result_url(raw: str) -> str:
    parsed = urllib.parse.urlsplit(raw)
    host = (parsed.hostname or "").rstrip(".").lower()
    if parsed.scheme != "https" or not host.endswith(".aliyuncs.com"):
        raise UsageError("provider result URL is outside the approved Aliyun HTTPS domain")
    if parsed.username or parsed.password or parsed.port not in (None, 443):
        raise UsageError("provider result URL contains forbidden authority fields")
    return raw


def _download(raw_url: str, *, kind: str, output: str | None) -> Path:
    url = _result_url(raw_url)
    explicit = _validate_output(output)
    directory = explicit.parent if explicit else _output_directory()
    _reject_symlink_components(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = directory.resolve(strict=True)
    if not _inside_home(directory):
        raise UsageError("download directory escaped the current user's home")
    os.chmod(directory, 0o700)
    maximum = MAX_IMAGE_DOWNLOAD if kind == "image" else MAX_VIDEO_DOWNLOAD
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "nexuscrew-alibaba-token-media-skill/1"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            _result_url(response.geturl())
            content_type = response.headers.get_content_type()
            length = response.headers.get("Content-Length")
            if length and int(length) > maximum:
                raise UsageError(f"{kind} download exceeds the configured safety limit")
            if kind == "image" and not content_type.startswith("image/"):
                raise UsageError(f"unexpected image content type: {content_type}")
            if kind == "video" and content_type not in ("video/mp4", "application/octet-stream"):
                raise UsageError(f"unexpected video content type: {content_type}")
            extension = ".mp4" if kind == "video" else mimetypes.guess_extension(content_type) or ".img"
            if explicit:
                target = explicit
            else:
                stamp = dt.datetime.now().astimezone().strftime("%Y%m%d_%H%M%S")
                target = directory / f"{kind}_{stamp}_{secrets.token_hex(3)}{extension}"
            if target.exists():
                raise UsageError("output path already exists; overwrite is forbidden")
            fd, temp_name = tempfile.mkstemp(prefix=".download-", dir=directory)
            total = 0
            try:
                with os.fdopen(fd, "wb") as handle:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > maximum:
                            raise UsageError(f"{kind} download exceeded the configured safety limit")
                        handle.write(chunk)
                if total == 0:
                    raise UsageError("provider result download was empty")
                os.link(temp_name, target)
                os.chmod(target, 0o600)
            finally:
                Path(temp_name).unlink(missing_ok=True)
    except urllib.error.URLError as exc:
        raise UsageError(f"result download failed: {exc.reason}") from None
    return target


def _status(_: argparse.Namespace) -> None:
    _emit({
        "configured": bool(os.environ.get(KEY_ENV)),
        "credential_env": KEY_ENV,
        "host": HOST,
        "supported_clients": ["claude-code", "codex", "codex-vl", "pi"],
        "image_models": list(IMAGE_MODELS),
        "video_models": list(VIDEO_MODELS),
        "lite_defaults": {"image": "wan2.7-image/1K/n=1", "video": "720P/3s/n=1"},
        "local_limits": {"batch": False, "concurrent_submits": 1, "automatic_post_retry": False},
    })


def _image(args: argparse.Namespace) -> None:
    prompt = _validate_prompt(args.prompt)
    images = [_image_value(item) for item in args.image]
    if len(images) > 9:
        raise UsageError("Wan accepts at most nine input images")
    if args.size == "4K" and (args.model != "wan2.7-image-pro" or images):
        raise UsageError("4K is only valid for wan2.7-image-pro text-to-image")
    if args.model == "wan2.7-image" and args.size == "4K":
        raise UsageError("wan2.7-image does not support 4K")
    high_cost = args.model == "wan2.7-image-pro" or args.size != "1K"
    if high_cost and not args.confirm_high_cost:
        raise UsageError("Wan Pro, 2K, and 4K require --confirm-high-cost")
    content: list[dict[str, str]] = [{"text": prompt}]
    content.extend({"image": item} for item in images)
    parameters: dict[str, Any] = {
        "n": 1,
        "size": args.size,
        "enable_sequential": False,
        "watermark": args.watermark,
        "thinking_mode": not args.no_thinking,
    }
    if args.seed is not None:
        parameters["seed"] = args.seed
    payload = {
        "model": args.model,
        "input": {"messages": [{"role": "user", "content": content}]},
        "parameters": parameters,
    }
    if args.dry_run:
        _emit({"dry_run": True, "method": "POST", "url": IMAGE_URL, "payload": _safe_payload(payload)})
        return
    if not args.confirm_credit_use:
        raise UsageError("real image generation requires --confirm-credit-use")
    with _submit_lock():
        result = _request_json(IMAGE_URL, key=_require_key(), payload=payload)
    urls: list[str] = []
    for choice in result.get("output", {}).get("choices", []):
        for item in choice.get("message", {}).get("content", []):
            if isinstance(item, dict) and isinstance(item.get("image"), str):
                urls.append(item["image"])
    if len(urls) != 1:
        raise UsageError(f"expected one generated image URL, received {len(urls)}")
    target = _download(urls[0], kind="image", output=args.output)
    _emit({
        "status": "SUCCEEDED",
        "file": str(target),
        "request_id": result.get("request_id"),
        "usage": result.get("usage"),
    })


def _video_submit(args: argparse.Namespace) -> None:
    i2v = args.model == "happyhorse-1.1-i2v"
    prompt = _validate_prompt(args.prompt or "", video=True, optional=i2v)
    if i2v and not args.image:
        raise UsageError("happyhorse-1.1-i2v requires exactly one --image")
    if not i2v and args.image:
        raise UsageError("happyhorse-1.1-t2v does not accept --image")
    if i2v and args.ratio != "16:9":
        raise UsageError("image-to-video follows the input image; do not set --ratio")
    high_cost = args.resolution == "1080P" or args.duration > 5
    if high_cost and not args.confirm_high_cost:
        raise UsageError("1080P or duration above five seconds requires --confirm-high-cost")
    input_data: dict[str, Any] = {}
    if prompt:
        input_data["prompt"] = prompt
    parameters: dict[str, Any] = {
        "resolution": args.resolution,
        "duration": args.duration,
        "watermark": args.watermark,
    }
    if i2v:
        input_data["media"] = [{"type": "first_frame", "url": _image_value(args.image, i2v=True)}]
    else:
        parameters["ratio"] = args.ratio
    if args.seed is not None:
        parameters["seed"] = args.seed
    payload = {"model": args.model, "input": input_data, "parameters": parameters}
    if args.dry_run:
        _emit({"dry_run": True, "method": "POST", "url": VIDEO_URL, "payload": _safe_payload(payload)})
        return
    if not args.confirm_credit_use or not args.confirm_expensive:
        raise UsageError("real video generation requires --confirm-credit-use and --confirm-expensive")
    with _submit_lock():
        result = _request_json(
            VIDEO_URL,
            key=_require_key(),
            payload=payload,
            asynchronous=True,
        )
    output = result.get("output", {})
    task_id = output.get("task_id")
    if not isinstance(task_id, str) or not TASK_ID_RE.fullmatch(task_id):
        raise UsageError("provider did not return a valid task ID")
    _emit({
        "task_id": task_id,
        "task_status": output.get("task_status"),
        "request_id": result.get("request_id"),
    })


def _video_status(args: argparse.Namespace) -> None:
    if not TASK_ID_RE.fullmatch(args.task_id):
        raise UsageError("invalid task ID")
    url = TASK_URL.format(task_id=urllib.parse.quote(args.task_id, safe=""))
    result = _request_json(url, key=_require_key())
    output = result.get("output", {})
    status = output.get("task_status")
    response: dict[str, Any] = {
        "task_id": output.get("task_id", args.task_id),
        "task_status": status,
        "request_id": result.get("request_id"),
    }
    if status == "FAILED":
        response["error"] = {"code": output.get("code"), "message": output.get("message")}
    if status == "SUCCEEDED":
        response["usage"] = result.get("usage")
        if args.download:
            raw_url = output.get("video_url")
            if not isinstance(raw_url, str):
                raise UsageError("successful task response omitted video_url")
            response["file"] = str(_download(raw_url, kind="video", output=args.output))
    elif args.download:
        raise UsageError(f"task is {status!r}; download is available only after SUCCEEDED")
    _emit(response)


def _seed(value: str) -> int:
    number = int(value)
    if not 0 <= number <= 2_147_483_647:
        raise argparse.ArgumentTypeError("seed must be from 0 through 2147483647")
    return number


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    status = sub.add_parser("status", help="show allowlist and whether the key is configured")
    status.set_defaults(run=_status)

    image = sub.add_parser("image", help="generate or edit exactly one Wan image")
    image.add_argument("--prompt", required=True)
    image.add_argument("--model", choices=IMAGE_MODELS, default="wan2.7-image")
    image.add_argument("--size", choices=("1K", "2K", "4K"), default="1K")
    image.add_argument("--image", action="append", default=[], metavar="PATH_OR_HTTPS_URL")
    image.add_argument("--watermark", action="store_true")
    image.add_argument("--no-thinking", action="store_true")
    image.add_argument("--seed", type=_seed)
    image.add_argument("--output")
    image.add_argument("--dry-run", action="store_true")
    image.add_argument("--confirm-credit-use", action="store_true")
    image.add_argument("--confirm-high-cost", action="store_true")
    image.set_defaults(run=_image)

    video = sub.add_parser("video-submit", help="submit one HappyHorse video task")
    video.add_argument("--prompt")
    video.add_argument("--model", choices=VIDEO_MODELS, default="happyhorse-1.1-t2v")
    video.add_argument("--image", metavar="PATH_OR_HTTPS_URL")
    video.add_argument("--resolution", choices=("720P", "1080P"), default="720P")
    video.add_argument("--duration", type=int, choices=range(3, 16), default=3)
    video.add_argument("--ratio", choices=VIDEO_RATIOS, default="16:9")
    video.add_argument("--watermark", action=argparse.BooleanOptionalAction, default=True)
    video.add_argument("--seed", type=_seed)
    video.add_argument("--dry-run", action="store_true")
    video.add_argument("--confirm-credit-use", action="store_true")
    video.add_argument("--confirm-expensive", action="store_true")
    video.add_argument("--confirm-high-cost", action="store_true")
    video.set_defaults(run=_video_submit)

    task = sub.add_parser("video-status", help="query one HappyHorse task and optionally download it")
    task.add_argument("task_id")
    task.add_argument("--download", action="store_true")
    task.add_argument("--output")
    task.set_defaults(run=_video_status)
    return parser


def main() -> int:
    try:
        args = _parser().parse_args()
        args.run(args)
        return 0
    except UsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except (OSError, ValueError) as exc:
        print(f"error: local validation failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
