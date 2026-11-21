"""Command line: list, run, decide, summary, report.

Examples (from services/gemini)::

    python -m path_gemini.trial list ../../captures-local/turn1
    python -m path_gemini.trial run ../../captures-local/turn1 --maneuver left \\
        --approach photo-3 --junction photo-5 --exit photo-7 --label "Check-in to hardware lab"
    python -m path_gemini.trial decide <run-folder> accept
    python -m path_gemini.trial summary
"""

import argparse
import os
import sys
import webbrowser
from pathlib import Path
from typing import Callable, List, Optional

from ..config import GeminiConfig
from ..errors import ConfigurationError, LandmarkError
from ..models import LandmarkRequest, Maneuver
from ..prompt import PROMPT_VERSION
from ..service import LandmarkService
from .inputs import TrialInputError, find_frame, load_frames, read_image
from .report import write_report
from .runlog import (
    DECISIONS,
    PrivateOutputError,
    default_log_dir,
    ensure_private_dir,
    new_run_dir,
    record_decision,
    summarize,
    summary_text,
    write_json,
)

PACKAGE_ENV = Path(__file__).resolve().parents[3] / ".env"
EXT = {"image/jpeg": ".jpg", "image/png": ".png"}


def load_env_file(path: Optional[Path]) -> None:
    """Load GEMINI_* values from a local .env without overriding the environment."""
    if path is None or not path.is_file():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name, value = name.strip(), value.strip().strip('"').strip("'")
        if name.startswith("GEMINI_") and name not in os.environ:
            os.environ[name] = value


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m path_gemini.trial",
                                description="Try Gemini landmark cues on local photos and record evidence.")
    sub = p.add_subparsers(dest="command", required=True)

    ls = sub.add_parser("list", help="show the frames found in a capture folder")
    ls.add_argument("folder", type=Path)

    run = sub.add_parser("run", help="send 2-3 frames to Gemini and save a report")
    run.add_argument("folder", type=Path, help="capture folder (keyframes.json, frames.json, or images)")
    run.add_argument("--maneuver", required=True, choices=[m.value for m in Maneuver],
                     help="the verified turn (Gemini never changes it)")
    run.add_argument("--approach", help="frame ID or file name seen while approaching")
    run.add_argument("--junction", help="frame ID or file name at the turn")
    run.add_argument("--exit", dest="exit_", help="frame ID or file name just after the turn")
    run.add_argument("--label", default="", help="short description, e.g. 'Check-in to hardware lab'")
    run.add_argument("--approach-direction", default="approach-a",
                     help="ID for this direction of travel; the opposite approach is a separate run")
    run.add_argument("--scan-revision", default="local-trial")
    run.add_argument("--segment", default="segment-1")
    run.add_argument("--max-side", type=int, default=1280, help="downscale longest side (needs Pillow)")
    run.add_argument("--log-dir", type=Path, help="private output folder (default: captures-local/gemini-trials)")
    run.add_argument("--env-file", type=Path, default=PACKAGE_ENV)
    run.add_argument("--open", action="store_true", help="open the report in a browser when done")

    dec = sub.add_parser("decide", help="record the organizer's decision for a run")
    dec.add_argument("run_dir", type=Path)
    dec.add_argument("decision", choices=DECISIONS)
    dec.add_argument("--candidate", type=int, help="candidate number for accept/edit (default 0)")
    dec.add_argument("--text", help="corrected instruction (edit) or hand-written one (manual)")
    dec.add_argument("--note", help="optional reviewer note")

    sm = sub.add_parser("summary", help="print evidence counts across runs")
    sm.add_argument("--log-dir", type=Path)

    rep = sub.add_parser("report", help="re-create report.html for a run")
    rep.add_argument("run_dir", type=Path)
    return p


def _cmd_list(args, out) -> int:
    layout, frames = load_frames(args.folder)
    print("{} frames from {}".format(len(frames), layout), file=out)
    for f in frames:
        ts = "{:7.2f}s".format(f.timestamp_seconds) if f.timestamp_seconds is not None else "      -"
        track = "" if f.tracking in (None, "normal") else "  [tracking: {}]".format(f.tracking)
        print("  {:<24} {}  {}{}".format(f.frame_id, ts, f.path.name, track), file=out)
    return 0


def _cmd_run(args, out, service_factory: Callable[[], LandmarkService]) -> int:
    roles = [("approach", args.approach), ("junction", args.junction), ("exit", args.exit_)]
    chosen = [(role, key) for role, key in roles if key]
    if len(chosen) < 2:
        raise TrialInputError("pick at least two of --approach, --junction, --exit")
    layout, frames = load_frames(args.folder)
    picked = [(role, find_frame(frames, key)) for role, key in chosen]
    if len({f.frame_id for _, f in picked}) != len(picked):
        raise TrialInputError("each role needs a different frame")

    load_env_file(args.env_file)
    service = service_factory()  # fails fast on a missing key, before writing anything

    log_dir = (args.log_dir or default_log_dir(Path.cwd())).resolve()
    ensure_private_dir(log_dir)
    label = args.label or "{} turn".format(args.maneuver)
    run_dir = new_run_dir(log_dir, label)

    frame_records, request_frames = [], []
    for role, frame in picked:
        data, mime, info = read_image(frame, max_side=args.max_side, max_bytes=service.config.max_image_bytes)
        name = "{}-{}{}".format(role, frame.frame_id, EXT[mime])
        (run_dir / "images" / name).write_bytes(data)
        frame_records.append({"role": role, "frameId": frame.frame_id, "file": name, "mimeType": mime,
                              "sourceName": frame.path.name, "timestampSeconds": frame.timestamp_seconds,
                              "tracking": frame.tracking, **info})
        request_frames.append({"frameId": frame.frame_id, "role": role, "mimeType": mime,
                               "imageBytes": data, "timestampSeconds": frame.timestamp_seconds})
        if frame.tracking not in (None, "normal"):
            print("note: {} had tracking state {!r}".format(frame.frame_id, frame.tracking), file=out)

    write_json(run_dir / "run.json", {
        "label": label, "maneuver": args.maneuver, "layout": layout, "sourceFolder": args.folder.name,
        "approachDirectionId": args.approach_direction, "scanRevisionId": args.scan_revision,
        "routeSegmentId": args.segment, "model": service.config.model, "promptVersion": PROMPT_VERSION,
        "frames": frame_records,
    })
    request = LandmarkRequest.model_validate({
        "requestId": "trial-" + run_dir.name,
        "scanRevisionId": args.scan_revision,
        "routeSegmentId": args.segment,
        "approachDirectionId": args.approach_direction,
        "waypoints": {"approachWaypointId": "wp-approach", "junctionWaypointId": "wp-junction",
                      "exitWaypointId": "wp-exit"},
        "verifiedMovement": {"maneuver": args.maneuver},
        "frames": request_frames,
    })

    print("Asking {} (prompt {}) about a verified '{}' turn with {} frames...".format(
        service.config.model, PROMPT_VERSION, args.maneuver, len(request_frames)), file=out)
    code = 0
    try:
        result = service.propose_landmarks(request)
    except LandmarkError as err:
        write_json(run_dir / "error.json", err.to_dict())
        print("FAILED {}: {}".format(err.code.value, err.message), file=out)
        code = 2
    else:
        write_json(run_dir / "result.json", result.model_dump(mode="json", by_alias=True))
        if result.abstained:
            print("No clear landmark: {}".format(result.abstention_reason), file=out)
        for i, cand in enumerate(result.candidates):
            print("  [{}] {}  (landmark: {}; frames: {}; {})".format(
                i, cand.instruction, cand.landmark, ", ".join(cand.source_frame_ids), cand.visibility.value), file=out)
        print("{} ms, {} attempt(s)".format(result.elapsed_ms, result.attempts), file=out)

    report = write_report(run_dir)
    print("Run folder: {}".format(run_dir), file=out)
    print("Report:     {}".format(report), file=out)
    print("Next:       python -m path_gemini.trial decide \"{}\" accept|edit|reject|agree|manual".format(run_dir),
          file=out)
    if args.open:
        webbrowser.open(report.as_uri())
    return code


def main(argv: Optional[List[str]] = None, *, service_factory: Optional[Callable[[], LandmarkService]] = None,
         out=None) -> int:
    out = out or sys.stdout
    args = _parser().parse_args(argv)
    factory = service_factory or (lambda: LandmarkService(GeminiConfig.from_env()))
    try:
        if args.command == "list":
            return _cmd_list(args, out)
        if args.command == "run":
            return _cmd_run(args, out, factory)
        if args.command == "decide":
            record = record_decision(args.run_dir, args.decision, candidate=args.candidate,
                                     text=args.text, note=args.note)
            write_report(args.run_dir)
            print("Recorded: {}{}".format(record["decision"],
                                          " -> " + record["approvedText"] if record.get("approvedText") else ""),
                  file=out)
            return 0
        if args.command == "summary":
            log_dir = (args.log_dir or default_log_dir(Path.cwd())).resolve()
            print(summary_text(summarize(log_dir)), file=out)
            return 0
        if args.command == "report":
            print(write_report(args.run_dir), file=out)
            return 0
    except (TrialInputError, PrivateOutputError, ValueError, ConfigurationError) as err:
        print("error: {}".format(err), file=sys.stderr)
        return 1
    return 1
