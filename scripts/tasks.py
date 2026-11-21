"""Share Path App tasks and progress in GitHub Issues. Run with --help for commands."""

import argparse
import json
import re
import subprocess
import sys

from setup_entire import REPO, ROOT, verify_destination


ACTIVE = "task:active"
READY = "task:ready"
CHECKPOINT = "**Checkpoint**"
DONE = "**Done**"
ISSUES_URL = f"https://github.com/{REPO}/issues"
BOARD_MARKER = "<!-- path-app-team-board -->"


def run(*args, body=None):
    result = subprocess.run(args, cwd=ROOT, input=body, text=True, capture_output=True)
    if result.returncode:
        raise ValueError(result.stderr.strip() or f"{args[0]} exited with {result.returncode}")
    return result.stdout.strip()


def issue(*args, body=None):
    return run("gh", "issue", *args, "--repo", f"github.com/{REPO}", body=body)


def api(*args):
    return run("gh", "api", "--hostname", "github.com", *args)


def login():
    return api("user", "--jq", ".login")


def text_arg(value):
    if not value.strip():
        raise argparse.ArgumentTypeError("Enter some text.")
    return value.strip()


def number_arg(value):
    if not re.fullmatch(r"[1-9][0-9]*", value):
        raise argparse.ArgumentTypeError("Use a GitHub issue number such as 12.")
    return value


def current(number):
    item = json.loads(api(f"repos/{REPO}/issues/{number}"))
    if "pull_request" in item:
        raise ValueError(f"#{number} is a pull request. Use its linked task issue.")
    if (item.get("body") or "").lstrip().startswith(BOARD_MARKER):
        raise ValueError(f"#{number} is the team board. Choose a task listed on it.")
    labels = {label["name"] for label in item["labels"]}
    if not labels.intersection((ACTIVE, READY)):
        raise ValueError(f"#{number} needs a {READY} or {ACTIVE} task label. Check {item['html_url']}")
    return item


def require_open(task):
    if task["state"] != "open":
        raise ValueError(f"Task is already closed: {task['html_url']}")


def new(args):
    body = f"**Done when**\n\n{args.check}" if args.check else ""
    own = json.loads(issue("list", "--state", "open", "--assignee", "@me", "--label", ACTIVE,
                           "--limit", "100", "--json", "title,body,url"))
    for task in own:
        if task["title"] == args.title and (task["body"] or "").strip() == body:
            print(task["url"])
            return
    url = issue("create", "--assignee", "@me", "--label", ACTIVE, "--title", args.title,
                "--body-file", "-", body=body)
    print(url)


def claim(args):
    task = current(args.number)
    require_open(task)
    me = login().lower()
    owners = {owner["login"].lower() for owner in task["assignees"]}
    labels = {label["name"] for label in task["labels"]}
    if owners and me not in owners:
        raise ValueError(f"Already assigned to {', '.join(sorted(owners))}: {task['html_url']}")
    if me not in owners:
        # Add just our own login so another teammate's simultaneous claim survives.
        claimed = json.loads(api(f"repos/{REPO}/issues/{args.number}/assignees",
                                 "--method", "POST", "-f", f"assignees[]={me}"))
        owners = {owner["login"].lower() for owner in claimed["assignees"]}
        if me not in owners:
            raise ValueError(f"GitHub did not assign the issue to @{me}. Check {task['html_url']}")
        if len(owners) > 1:
            print(f"Concurrent claim by {', '.join(sorted(owners))}. Coordinate on {task['html_url']}",
                  file=sys.stderr)
    changes = []
    if ACTIVE not in labels:
        changes += ["--add-label", ACTIVE]
    if READY in labels:
        changes += ["--remove-label", READY]
    if changes:
        issue("edit", args.number, *changes)
    print(f"Active · {', '.join('@' + name for name in sorted(owners))} · {task['html_url']}")


def evidence(ref):
    verify_destination()
    if ref != "HEAD" and not re.fullmatch(r"[a-fA-F0-9]{7,40}", ref):
        raise ValueError("Use --head or --commit with a 7–40 digit commit SHA.")
    sha = run("git", "rev-parse", "--verify", f"{ref}^{{commit}}")
    refs = run("git", "ls-remote", "origin", "refs/heads/*", "refs/entire/checkpoints/*")
    heads = set()
    checkpoint_ids = set()
    for line in refs.splitlines():
        oid, name = line.split()
        if name.startswith("refs/heads/"):
            heads.add(oid)
        elif name.startswith("refs/entire/checkpoints/"):
            checkpoint_ids.add(name.rsplit("/", 1)[-1])
    # A newly advanced remote branch may have a tip missing from the local clone.
    if sha not in heads and not any(
        subprocess.run(["git", "merge-base", "--is-ancestor", sha, tip], cwd=ROOT,
                       capture_output=True).returncode == 0 for tip in heads
    ):
        raise ValueError("Could not verify this commit on an origin branch. Push the task branch "
                         "or fetch origin and retry. Omit the commit option for a text update.")
    lines = [f"**Commit** https://github.com/{REPO}/commit/{sha}"]
    trailers = run("git", "show", "-s", "--format=%(trailers:key=Entire-Checkpoint,valueonly)", sha)
    for checkpoint_id in dict.fromkeys(trailers.splitlines()):
        if checkpoint_id not in checkpoint_ids:
            raise ValueError(f"Entire checkpoint {checkpoint_id!r} is missing on origin. Review it "
                             "and run 'entire checkpoint push ID', or post a text update.")
        lines.append(f"**Entire checkpoint** `{checkpoint_id}`")
    return lines


def history(number):
    pages = json.loads(api(f"repos/{REPO}/issues/{number}/comments?per_page=100", "--paginate", "--slurp"))
    return [dict(body=comment["body"], author=comment["user"], createdAt=comment["created_at"],
                 url=comment["html_url"]) for page in pages for comment in page]


def milestone(args):
    task = current(args.number)
    closing = args.command == "done"
    if closing and task["state"] == "closed":
        print(f"Already closed · {task['html_url']}")
        return
    require_open(task)
    parts = [DONE if closing else CHECKPOINT, args.result]
    if getattr(args, "next", None):
        parts.append(f"**Next** {args.next}")
    if args.ref:
        parts.extend(evidence(args.ref))
    body = "\n\n".join(parts)
    # gh may post the closing comment before the close request fails. A retry
    # should finish closing the issue without repeating that progress update.
    repeated = False
    if task["comments"]:
        me = login().lower()
        previous = next((comment for comment in reversed(history(args.number))
                         if (comment["author"] or {}).get("login", "").lower() == me), {})
        repeated = previous.get("body", "").strip() == body
    if closing:
        options = [] if repeated else ["--comment", body]
        issue("close", args.number, "--reason", "completed", *options)
    elif not repeated:
        print(issue("comment", args.number, "--body-file", "-", body=body))
        return
    print(task["html_url"])


# Read the live issue connection. GitHub's indexed search can lag behind a claim or update.
TASK_QUERY = """
query($endCursor: String) {
  repository(owner: "darkprince558", name: "path-app") {
    issues(first: 25, after: $endCursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body state stateReason updatedAt closedAt url
        assignees(first: 100) { nodes { login } }
        labels(first: 100) { nodes { name } }
        comments(last: 100) { totalCount nodes { body createdAt url author { login } } }
      }
    }
  }
}
"""


def checkpoint_text(body):
    lines = body.strip().splitlines()
    if not lines:
        return None
    if lines[0].strip() in (CHECKPOINT, DONE):
        return "\n".join(lines[1:]).strip()
    match = re.match(r"^(?:checkpoint|done):\s*(.*)$", lines[0], re.IGNORECASE)
    if match:
        return "\n".join([match.group(1)] + lines[1:]).strip()
    return None


def latest(comments):
    for comment in reversed(comments):
        body = checkpoint_text(comment["body"])
        if body:
            result = " ".join(body.split())
            author = (comment["author"] or {}).get("login", "deleted-user")
            return f"{result} · @{author} · {comment['createdAt']}"
    return None


def task_groups(person=None):
    if person == "@me":
        person = login().lower()
    elif person:
        person = person.lstrip("@").lower()
    pages = json.loads(api("graphql", "--paginate", "--slurp", "-f", f"query={TASK_QUERY}"))
    active, ready, completed = [], [], []
    for page in pages:
        for task in page["data"]["repository"]["issues"]["nodes"]:
            if (task["body"] or "").lstrip().startswith(BOARD_MARKER):
                continue
            owners = [owner["login"] for owner in task["assignees"]["nodes"]]
            if person and person not in (name.lower() for name in owners):
                continue
            labels = {label["name"] for label in task["labels"]["nodes"]}
            if not labels.intersection((ACTIVE, READY)):
                continue
            if task["state"] == "CLOSED":
                if task["stateReason"] in ("NOT_PLANNED", "DUPLICATE"):
                    continue
                group = completed
            else:
                group = active if ACTIVE in labels else ready
            group.append(task)
    completed.sort(key=lambda task: task["closedAt"] or task["updatedAt"], reverse=True)
    groups = (("Active", active), ("Ready to claim", ready), ("Recently completed", completed[:10]))
    for _, tasks in groups:
        for task in tasks:
            comments = task["comments"]
            if comments["totalCount"] > len(comments["nodes"]) and not latest(comments["nodes"]):
                comments["nodes"] = history(task["number"])
    return groups


def status(args):
    for title, tasks in task_groups(args.person):
        print(title)
        if not tasks:
            print("  None")
        for task in tasks:
            owner = ", ".join("@" + user["login"] for user in task["assignees"]["nodes"]) or "unassigned"
            update = latest(task["comments"]["nodes"]) or "No checkpoint yet"
            label = f"#{task['number']} {task['title']} · {owner} · updated {task['updatedAt']}"
            print(f"{label}\n  {update}\n  {task['url']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("new", help="create a task and assign it to yourself")
    start.add_argument("title", type=text_arg)
    start.add_argument("--check", type=text_arg, help="what a teammate can verify")
    take = commands.add_parser("claim", help="claim an open issue")
    take.add_argument("number", type=number_arg)
    for name, help_text in (("checkpoint", "post a progress update"), ("done", "share the result and close the task")):
        sub = commands.add_parser(name, help=help_text)
        sub.add_argument("number", type=number_arg)
        sub.add_argument("result", type=text_arg)
        if name == "checkpoint":
            sub.add_argument("--next", type=text_arg, help="next action or blocker")
        group = sub.add_mutually_exclusive_group()
        group.add_argument("--head", action="store_const", const="HEAD", dest="ref",
                           help="attach the current commit after checking it reached origin")
        group.add_argument("--commit", dest="ref", metavar="SHA", help="attach a specific pushed commit")
    show = commands.add_parser("status", help="show the team's tasks and latest checkpoints")
    show.add_argument("--person", type=text_arg, help="filter by GitHub login or @me")
    args = parser.parse_args()
    actions = {"new": new, "claim": claim, "checkpoint": milestone, "done": milestone, "status": status}
    actions[args.command](args)


if __name__ == "__main__":
    try:
        main()
    except FileNotFoundError as error:
        sys.exit(f"Install {error.filename} and retry.")
    except (ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
