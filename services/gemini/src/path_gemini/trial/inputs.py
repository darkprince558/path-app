"""Read candidate frames from a capture folder.

Three layouts are supported, checked in this order:

1. ``keyframes.json`` from the native PathCapture recorder (Anish): a list of
   ``{"camera": {"t", "tracking", ...}, "jpeg": "photo-N.jpg", ...}``.
2. ``frames.json`` from the handoff contract: a list (or ``{"frames": [...]}``)
   of ``{"frameId", "imagePath", "mimeType", "timestampSeconds", ...}``.
3. A plain folder of ``.jpg``/``.jpeg``/``.png`` files, sorted by name.

Images are only read from inside the folder. Paths that escape it are rejected.
"""

import io
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

IMAGE_SUFFIXES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    # iPhone default. Converted to JPEG before sending (needs pillow-heif).
    ".heic": "image/heic",
    ".heif": "image/heif",
}
HEIF_TYPES = ("image/heic", "image/heif")
_UNSAFE_ID_CHARS = re.compile(r"[^A-Za-z0-9._:-]+")


class TrialInputError(ValueError):
    """A problem with the capture folder or the selected frames."""


@dataclass(frozen=True)
class FrameFile:
    frame_id: str
    path: Path
    mime_type: str
    timestamp_seconds: Optional[float] = None
    tracking: Optional[str] = None
    source: str = "folder"


def sanitize_id(value: str) -> str:
    cleaned = _UNSAFE_ID_CHARS.sub("-", value).strip("-.:_")
    return cleaned[:128] or "frame"


def _inside(folder: Path, relative: str) -> Path:
    candidate = (folder / relative).resolve()
    if folder.resolve() not in candidate.parents and candidate != folder.resolve():
        raise TrialInputError("image path escapes the capture folder: {}".format(relative))
    return candidate


def _mime_for(path: Path) -> str:
    mime = IMAGE_SUFFIXES.get(path.suffix.lower())
    if not mime:
        raise TrialInputError("unsupported image type {} (use JPEG, PNG or HEIC)".format(path.name))
    return mime


def load_frames(folder: Path) -> Tuple[str, List[FrameFile]]:
    """Return ``(layout, frames)`` for a capture folder."""
    folder = Path(folder)
    if not folder.is_dir():
        raise TrialInputError("not a folder: {}".format(folder))
    if (folder / "keyframes.json").is_file():
        return "keyframes.json", _from_keyframes(folder)
    if (folder / "frames.json").is_file():
        return "frames.json", _from_frames_json(folder)
    frames = [
        FrameFile(sanitize_id(p.stem), p.resolve(), _mime_for(p))
        for p in sorted(folder.iterdir(), key=lambda p: p.name.lower())
        if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES
    ]
    if not frames:
        raise TrialInputError("no keyframes.json, frames.json or JPEG/PNG images in {}".format(folder))
    return "images", _unique(frames)


def _from_keyframes(folder: Path) -> List[FrameFile]:
    data = json.loads((folder / "keyframes.json").read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise TrialInputError("keyframes.json must be a JSON list")
    frames = []
    times = [((item.get("camera") or {}).get("t")) for item in data if isinstance(item, dict)]
    numeric = [t for t in times if isinstance(t, (int, float))]
    origin = min(numeric) if numeric else None
    for item in data:
        if not isinstance(item, dict) or not item.get("jpeg"):
            continue
        path = _inside(folder, str(item["jpeg"]))
        camera = item.get("camera") or {}
        t = camera.get("t")
        frames.append(
            FrameFile(
                frame_id=sanitize_id(Path(str(item["jpeg"])).stem),
                path=path,
                mime_type=_mime_for(path),
                timestamp_seconds=(float(t) - origin) if isinstance(t, (int, float)) and origin is not None else None,
                tracking=camera.get("tracking"),
                source="keyframes.json",
            )
        )
    if not frames:
        raise TrialInputError("keyframes.json lists no photos")
    return _unique(frames)


def _from_frames_json(folder: Path) -> List[FrameFile]:
    data = json.loads((folder / "frames.json").read_text(encoding="utf-8"))
    items = data.get("frames") if isinstance(data, dict) else data
    if not isinstance(items, list):
        raise TrialInputError("frames.json must be a list or {\"frames\": [...]}")
    frames = []
    for item in items:
        if not isinstance(item, dict) or not item.get("imagePath"):
            continue
        path = _inside(folder, str(item["imagePath"]))
        mime = item.get("mimeType") or _mime_for(path)
        ts = item.get("timestampSeconds")
        frames.append(
            FrameFile(
                # Anish's export and the handoff use "frameId"; Sam's backend
                # frames.json v1 uses "id". Accept either.
                frame_id=sanitize_id(str(item.get("frameId") or item.get("id") or path.stem)),
                path=path,
                mime_type=mime,
                timestamp_seconds=float(ts) if isinstance(ts, (int, float)) else None,
                tracking=item.get("trackingState"),
                source="frames.json",
            )
        )
    if not frames:
        raise TrialInputError("frames.json lists no frames")
    return _unique(frames)


def _unique(frames: List[FrameFile]) -> List[FrameFile]:
    seen = {}
    out = []
    for f in frames:
        n = seen.get(f.frame_id, 0)
        seen[f.frame_id] = n + 1
        out.append(f if n == 0 else FrameFile(f.frame_id + "-" + str(n + 1), f.path, f.mime_type,
                                                f.timestamp_seconds, f.tracking, f.source))
    return out


def find_frame(frames: List[FrameFile], key: str) -> FrameFile:
    """Match a frame by ID, file name, or file stem."""
    for f in frames:
        if key in (f.frame_id, f.path.name, f.path.stem):
            return f
    raise TrialInputError("no frame named {!r}; run the 'list' command to see frame IDs".format(key))


def read_image(frame: FrameFile, *, max_side: int, max_bytes: int) -> Tuple[bytes, str, dict]:
    """Return ``(bytes, mime, info)``.

    With Pillow installed, the image is re-encoded: EXIF (including GPS) and
    other metadata are dropped, orientation is applied, and the longest side
    is capped at ``max_side``. Without Pillow, original bytes are used.
    HEIC/HEIF photos are always converted to JPEG, which needs pillow-heif.
    """
    raw = frame.path.read_bytes()
    info = {"originalBytes": len(raw), "normalized": False}
    is_heif = frame.mime_type in HEIF_TYPES
    if is_heif:
        try:
            import pillow_heif

            pillow_heif.register_heif_opener()
        except ImportError:
            raise TrialInputError(
                "{} is HEIC; install pillow-heif (pip install pillow-heif) or export it as JPEG".format(
                    frame.path.name)) from None
    try:
        from PIL import Image, ImageOps
    except ImportError:
        if is_heif:
            raise TrialInputError("HEIC photos need Pillow: pip install pillow pillow-heif") from None
        if len(raw) > max_bytes:
            raise TrialInputError(
                "{} is {} bytes (limit {}); install Pillow (pip install pillow) to downscale".format(
                    frame.path.name, len(raw), max_bytes)) from None
        return raw, frame.mime_type, info
    try:
        with Image.open(io.BytesIO(raw)) as img:
            img = ImageOps.exif_transpose(img)
            if max(img.size) > max_side:
                img.thumbnail((max_side, max_side))
            out = io.BytesIO()
            mime = frame.mime_type
            if mime == "image/png":
                img.save(out, format="PNG", optimize=True)
            else:
                img.convert("RGB").save(out, format="JPEG", quality=88)
                mime = "image/jpeg"
            data = out.getvalue()
            info.update(normalized=True, width=img.size[0], height=img.size[1])
    except Exception:  # noqa: BLE001 - surfaced as a clear input error
        raise TrialInputError("could not read {} as an image".format(frame.path.name)) from None
    info["sentBytes"] = len(data)
    if is_heif:
        info["convertedFrom"] = frame.mime_type
    return data, mime, info
