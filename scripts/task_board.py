"""Refresh the pinned team issue from GitHub's live task and comment data."""

from datetime import datetime
import os
import re
import sys

from tasks import ISSUES_URL, checkpoint_text, issue, task_groups


MARKER = "<!-- path-app-team-board -->"


def plain(value, limit):
    """Render user text as a single Markdown code span, including literal backticks."""
    value = " ".join(value.split())
    if len(value) > limit:
        value = value[:limit - 1].rstrip() + "…"
    delimiter = "`" * (max((len(m) for m in re.findall(r"`+", value)), default=0) + 1)
    return f"{delimiter} {value} {delimiter}"


def task_entry(task):
    url = f"{ISSUES_URL}/{int(task['number'])}"
    owners = ", ".join(owner["login"] for owner in task["assignees"]["nodes"])
    title = plain(task["title"], 120)
    row = f"- [#{task['number']}]({url}) {title} · {plain(owners, 150) if owners else 'Unassigned'}"
    for comment in reversed(task["comments"]["nodes"]):
        text = checkpoint_text(comment["body"])
        if not text:
            continue
        summary = []
        next_steps = []
        current = summary
        for line in text.splitlines():
            if line.startswith(("**Commit**", "**Entire checkpoint**")):
                break
            next_prefix = re.match(r"\s*(?:\*\*Next\*\*|Next:)\s*", line, re.IGNORECASE)
            if next_prefix:
                current = next_steps
                line = line[next_prefix.end():]
            current.append(line.strip())
        result = " ".join(summary).strip()
        next_step = " ".join(next_steps).strip()
        author = (comment["author"] or {}).get("login", "deleted-user")
        when = datetime.fromisoformat(comment["createdAt"].replace("Z", "+00:00"))
        stamp = when.strftime("%b %d, %H:%M UTC")
        comment_url = comment.get("url", "")
        if not re.fullmatch(re.escape(url) + r"#issuecomment-[0-9]+", comment_url):
            comment_url = url
        row += f"  \n  [{stamp}]({comment_url}) · {plain(author, 80)}"
        if result:
            row += " · " + plain(result, 240)
        if next_step:
            row += "  \n  Next · " + plain(next_step, 160)
        return row
    return row + "  \n  No checkpoint yet."


def render(groups):
    repo_url = ISSUES_URL.removesuffix("/issues")
    lines = [
        MARKER,
        "Open a task to see its checks and discussion. The board refreshes after task activity.",
        f"[Create a task]({ISSUES_URL}/new?template=agent-task.yml) · "
        f"[Task guide]({repo_url}/blob/main/docs/tasks.md) · "
        f"[Editable roadmap]({repo_url}/edit/main/planning/ROADMAP.md)",
    ]
    for title, tasks in groups:
        lines.append(f"## {title} ({len(tasks)})")
        entries = []
        size = 0
        for task in tasks:
            entry = task_entry(task)
            # Keep each section within its share of GitHub's issue body size limit.
            if size + len(entry) > 19500:
                entries.append(f"[Open the remaining tasks in Issues]({ISSUES_URL}).")
                break
            entries.append(entry)
            size += len(entry) + 1
        lines.append("\n".join(entries) if entries else "None.")
    return "\n\n".join(lines)


def main():
    number = os.environ.get("TEAM_BOARD_ISSUE", "")
    if not re.fullmatch("[1-9][0-9]*", number):
        sys.exit("Set TEAM_BOARD_ISSUE to the pinned issue number.")
    current = issue("view", number, "--json", "body", "--jq", ".body")
    if not current.startswith(MARKER):
        sys.exit(f"Add {MARKER} at the start of the board's body before refreshing it.")
    body = render(task_groups())
    if current != body:
        issue("edit", number, "--body-file", "-", body=body)


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        sys.exit(str(error))
