"""Self-contained HTML report: the photos sent beside Gemini's answer.

Every piece of text, including model output, is HTML-escaped. The page loads
nothing from the network. It embeds the photos, so keep it private.
"""

import base64
import html
from pathlib import Path
from typing import Optional

from .runlog import DECISION_HELP, read_json

CSS = """
:root{--bg:#f6f6f3;--card:#fff;--ink:#1d1d1b;--muted:#66665f;--line:#deded8;--accent:#2f5fd0;
--ok:#1f7a4a;--warn:#9a6200;--bad:#b3261e;--chip:#eef0f6}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecece8;--muted:#a3a39b;
--line:#34342f;--accent:#8fb0ff;--ok:#6fd39b;--warn:#f0b44d;--bad:#ff8a80;--chip:#2a2d36}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.muted{color:var(--muted)}.meta{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--muted)}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600;font-size:13px;border:1px solid}
.b-ok{color:var(--ok)}.b-warn{color:var(--warn)}.b-bad{color:var(--bad)}
.frames{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
figure.cited{outline:3px solid var(--accent)}figure img{display:block;width:100%;height:auto}
figcaption{padding:8px 10px;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 10px}
.instr{font-size:20px;font-weight:650;margin:0 0 6px}
.chip{display:inline-block;background:var(--chip);border-radius:6px;padding:1px 7px;margin:2px 4px 2px 0;
font:12px ui-monospace,SFMono-Regular,Consolas,monospace}
.verified{border-left:4px solid var(--ok)}.draft{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--warn)}
footer{margin-top:32px;font-size:12px;color:var(--muted)}
"""

ROLE_ORDER = {"approach": 0, "junction": 1, "exit": 2}


def _e(value) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def _img_tag(path: Path, mime: str, alt: str) -> str:
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return '<img alt="{}" src="data:{};base64,{}">'.format(_e(alt), _e(mime), data)


def render(run_dir: Path) -> str:
    run = read_json(run_dir / "run.json") or {}
    result = read_json(run_dir / "result.json")
    error = read_json(run_dir / "error.json")
    decision = read_json(run_dir / "decision.json")
    frames = sorted(run.get("frames", []), key=lambda f: ROLE_ORDER.get(f.get("role"), 9))
    cited = set()
    for cand in (result or {}).get("candidates") or []:
        cited.update(cand.get("sourceFrameIds") or [])

    out = ['<!doctype html><html lang="en"><head><meta charset="utf-8">',
           '<meta name="viewport" content="width=device-width,initial-scale=1">',
           "<title>Landmark trial</title><style>{}</style></head><body><main>".format(CSS)]
    out.append("<h1>{}</h1>".format(_e(run.get("label") or "Landmark trial")))
    out.append('<div class="card verified"><div class="muted">Verified route fact (from the route, not Gemini)</div>'
               '<div class="instr">Maneuver: {}{}</div></div>'.format(
                   _e(run.get("maneuver")), " (turn {})".format(_e(run["side"])) if run.get("side") else ""))

    if result is not None:
        status = ("Suggestions", "b-ok") if not result.get("abstained") else ("No clear landmark", "b-warn")
        meta = [
            ("Model", result.get("model")), ("Prompt", result.get("promptVersion")),
            ("Latency", "{} ms".format(result.get("elapsedMs"))), ("Attempts", result.get("attempts")),
            ("Tokens", (result.get("usage") or {}).get("totalTokenCount")),
            ("Fingerprint", (result.get("fingerprint") or "")[:19] + "…"),
        ]
    else:
        status = ("Failed: {}".format(error.get("code") if error else "incomplete"), "b-bad")
        meta = [("Model", run.get("model")), ("Prompt", run.get("promptVersion"))]
    out.append('<p><span class="badge {}">{}</span></p><div class="meta">{}</div>'.format(
        status[1], _e(status[0]),
        "".join("<span>{}: <b>{}</b></span>".format(_e(k), _e(v)) for k, v in meta if v is not None)))

    out.append("<h2>Photos sent to Gemini</h2><div class=\"frames\">")
    for f in frames:
        img = run_dir / "images" / f["file"]
        ts = f.get("timestampSeconds")
        caption = "<b>{}</b> · <span class=\"chip\">{}</span>{}".format(
            _e(f.get("role")), _e(f.get("frameId")),
            " · {:.2f} s".format(ts) if isinstance(ts, (int, float)) else "")
        out.append('<figure class="{}">{}<figcaption>{}</figcaption></figure>'.format(
            "cited" if f.get("frameId") in cited else "",
            _img_tag(img, f.get("mimeType", "image/jpeg"), "{} frame".format(f.get("role"))) if img.is_file() else "",
            caption))
    out.append("</div>")

    out.append("<h2>Gemini's answer</h2>")
    if result is not None and result.get("candidates"):
        for i, cand in enumerate(result["candidates"]):
            out.append(
                '<div class="card"><div class="draft">Draft {} · needs organizer approval</div>'
                '<p class="instr">{}</p><div>Landmark: <b>{}</b> ({}){} · visibility: {}</div>'
                "<div>Supported by: {}</div><div class=\"muted\">{}</div></div>".format(
                    i, _e(cand.get("instruction")), _e(cand.get("landmark")), _e(cand.get("landmarkType")),
                    " · visible text: <b>{}</b>".format(_e(cand["visibleText"])) if cand.get("visibleText") else "",
                    _e(cand.get("visibility")),
                    "".join('<span class="chip">{}</span>'.format(_e(x)) for x in cand.get("sourceFrameIds") or []),
                    _e(cand.get("reason"))))
    elif result is not None:
        out.append('<div class="card"><p class="instr">No clear landmark</p><div class="muted">{}</div></div>'.format(
            _e(result.get("abstentionReason"))))
    else:
        out.append('<div class="card"><p class="instr">{}</p><div class="muted">{}</div></div>'.format(
            _e((error or {}).get("message", "No result")), _e("; ".join((error or {}).get("details") or []))))

    out.append("<h2>Organizer decision</h2>")
    if decision:
        out.append('<div class="card verified"><b>{}</b>{}{}</div>'.format(
            _e(DECISION_HELP.get(decision.get("decision"), decision.get("decision"))),
            '<p class="instr">{}</p>'.format(_e(decision["approvedText"])) if decision.get("approvedText") else "",
            '<div class="muted">{}</div>'.format(_e(decision["note"])) if decision.get("note") else ""))
    else:
        out.append('<div class="card muted">Not reviewed yet. Record a decision with the <code>decide</code> command.</div>')

    out.append("<footer>Gemini output is a draft. Only organizer-approved text may be shown to guests. "
               "This page embeds private venue photos: do not commit or share it publicly.</footer>")
    out.append("</main></body></html>")
    return "".join(out)


def write_report(run_dir: Path) -> Path:
    path = run_dir / "report.html"
    path.write_text(render(run_dir), encoding="utf-8")
    return path
