"""Run folders, organizer decisions, and evidence counts.

Layout (one folder per run, all under a private, Git-ignored log directory)::

    <log-dir>/<UTC timestamp>-<label>/
        run.json       inputs: label, maneuver, frames and roles, IDs
        result.json    validated result, or
        error.json     typed failure (safe fields only)
        images/        the exact (normalized) bytes that were sent
        decision.json  organizer decision, once recorded
        report.html    photos beside Gemini's answer

Run folders contain private venue photos. ``ensure_private_dir`` refuses to
write inside a Git work tree unless the path is ignored.
"""

import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

DECISIONS = ("accept", "edit", "reject", "agree", "manual")
DECISION_HELP = {
    "accept": "accepted a candidate unchanged",
    "edit": "edited a candidate, then accepted it",
    "reject": "rejected every candidate",
    "agree": "agreed that no clear landmark is visible",
    "manual": "typed a landmark cue by hand",
}


class PrivateOutputError(RuntimeError):
    pass


def _git(args: List[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["git"] + args, cwd=str(cwd), capture_output=True, text=True, timeout=15)


def repo_root(start: Path) -> Optional[Path]:
    probe = start
    while not probe.exists():
        probe = probe.parent
    try:
        out = _git(["rev-parse", "--show-toplevel"], probe if probe.is_dir() else probe.parent)
    except (OSError, subprocess.SubprocessError):
        return None
    return Path(out.stdout.strip()) if out.returncode == 0 and out.stdout.strip() else None


def default_log_dir(cwd: Path) -> Path:
    root = repo_root(cwd)
    if root is not None:
        return root / "captures-local" / "gemini-trials"
    return cwd / "gemini-trials"


def ensure_private_dir(path: Path) -> None:
    """Refuse a directory that Git would track (photos must never be committed)."""
    path = path.resolve()
    root = repo_root(path)
    if root is None:
        return
    try:
        rel = path.relative_to(root.resolve())
    except ValueError:
        return
    probe = (rel / "probe-file.jpg").as_posix()
    result = _git(["check-ignore", "-q", probe], root)
    if result.returncode != 0:
        raise PrivateOutputError(
            "{} is inside the Git repository and not ignored. Use captures-local/ "
            "(ignored) or a folder outside the repo so photos are never committed.".format(path)
        )


def slug(text: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", text.lower()).strip("-")
    return s[:40] or "run"


def new_run_dir(log_dir: Path, label: str, now: Optional[datetime] = None) -> Path:
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%d-%H%M%S")
    base = log_dir / "{}-{}".format(stamp, slug(label))
    path, n = base, 2
    while path.exists():
        path = Path("{}-{}".format(base, n))
        n += 1
    (path / "images").mkdir(parents=True)
    return path


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


def outcome(run_dir: Path) -> str:
    result = read_json(run_dir / "result.json")
    if result is not None:
        return result.get("category", "UNKNOWN")
    error = read_json(run_dir / "error.json")
    if error is not None:
        return "FAILED:" + str(error.get("code"))
    return "INCOMPLETE"


def record_decision(run_dir: Path, decision: str, *, candidate: Optional[int] = None,
                    text: Optional[str] = None, note: Optional[str] = None) -> dict:
    if decision not in DECISIONS:
        raise ValueError("decision must be one of " + ", ".join(DECISIONS))
    if not (run_dir / "run.json").is_file():
        raise ValueError("not a trial run folder: {}".format(run_dir))
    result = read_json(run_dir / "result.json")
    candidates = (result or {}).get("candidates") or []
    record = {"decision": decision, "recordedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    if decision in ("accept", "edit"):
        if not candidates:
            raise ValueError("this run has no candidates to {}; use 'agree', 'manual' or 'reject'".format(decision))
        index = 0 if candidate is None else candidate
        if not 0 <= index < len(candidates):
            raise ValueError("candidate must be between 0 and {}".format(len(candidates) - 1))
        record["candidate"] = index
        record["original"] = candidates[index].get("instruction")
        if decision == "accept":
            record["approvedText"] = candidates[index].get("instruction")
        else:
            if not text or not text.strip():
                raise ValueError("edit needs --text with the corrected instruction")
            record["approvedText"] = text.strip()
    elif decision == "manual":
        if not text or not text.strip():
            raise ValueError("manual needs --text with the organizer's instruction")
        record["approvedText"] = text.strip()
    elif decision == "agree" and (result is None or not result.get("abstained")):
        raise ValueError("'agree' is only for runs where Gemini found no clear landmark")
    if note:
        record["note"] = note.strip()
    write_json(run_dir / "decision.json", record)
    return record


def list_runs(log_dir: Path) -> List[Path]:
    if not log_dir.is_dir():
        return []
    return sorted(p for p in log_dir.iterdir() if (p / "run.json").is_file())


def summarize(log_dir: Path) -> Dict[str, int]:
    counts = {
        "runs": 0, "withCandidates": 0, "candidatesSuggested": 0, "abstained": 0, "failed": 0,
        "accepted": 0, "edited": 0, "rejected": 0, "abstentionAgreed": 0, "manual": 0, "pending": 0,
    }
    key = {"accept": "accepted", "edit": "edited", "reject": "rejected", "agree": "abstentionAgreed", "manual": "manual"}
    for run in list_runs(log_dir):
        counts["runs"] += 1
        result = read_json(run / "result.json")
        if result is None:
            counts["failed"] += 1
        elif result.get("abstained"):
            counts["abstained"] += 1
        else:
            counts["withCandidates"] += 1
            counts["candidatesSuggested"] += len(result.get("candidates") or [])
        decision = read_json(run / "decision.json")
        if decision is None:
            counts["pending"] += 1
        else:
            counts[key[decision["decision"]]] += 1
    return counts


def summary_text(counts: Dict[str, int]) -> str:
    c = counts
    decided = c["runs"] - c["pending"]
    lines = [
        "Gemini landmark trials: {runs} runs".format(**c),
        "  Gemini output:  {withCandidates} with suggestions ({candidatesSuggested} candidates), "
        "{abstained} no clear landmark, {failed} failed".format(**c),
        "  Organizer:      {accepted} accepted unchanged, {edited} edited, {rejected} rejected, "
        "{abstentionAgreed} agreed with abstention, {manual} typed by hand, {pending} not yet reviewed".format(**c),
        "",
        "Devpost line: Across {} turn trials, Gemini suggested cues for {} and abstained on {} ({} failed). "
        "Of {} reviewed, the organizer accepted {} unchanged, edited {}, rejected {}, agreed with {} abstentions "
        "and entered {} by hand.".format(c["runs"], c["withCandidates"], c["abstained"], c["failed"], decided,
                                          c["accepted"], c["edited"], c["rejected"], c["abstentionAgreed"], c["manual"]),
    ]
    return "\n".join(lines)
