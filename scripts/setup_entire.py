"""Set up Entire for this Path App checkout. Run from the repository root."""

from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
REPO = "darkprince558/path-app"


def run(*command, output=False):
    result = subprocess.run(command, cwd=ROOT, check=True, text=True,
                            stdout=subprocess.PIPE if output else None)
    return result.stdout.strip() if output else None


def verify_destination():
    allowed = re.compile(
        r"(?:https://github\.com/|git@github\.com:|ssh://git@github\.com(?::22)?/"
        r"|ssh://git@ssh\.github\.com:443/)" + re.escape(REPO) + r"(?:\.git)?/?",
        re.IGNORECASE,
    )
    for flags in ([], ["--push"]):
        urls = run("git", "remote", "get-url", "--all", *flags, "origin", output=True)
        if not urls or not all(allowed.fullmatch(url) for url in urls.splitlines()):
            sys.exit(f"Run setup in a clone whose origin fetches and pushes only to github.com/{REPO}.")


def main():
    verify_destination()
    run("entire", "version")
    run("entire", "enable", "--yes", "--local", "--no-init-repo", "--agent", "codex",
        "--telemetry=false", "--checkpoint-push-remote", "origin",
        "--agent-help-skill=false", "--search-skill=false")
    run("entire", "agent", "add", "claude-code", "--agent-help-skill=false", "--search-skill=false")
    run("entire", "configure", "--checkpoint-push-policy", "automatic")
    for plugin in ("graph", "brain"):
        installed = subprocess.run(["entire", plugin, "version"], cwd=ROOT, capture_output=True)
        if installed.returncode:
            run("entire", "plugin", "install", plugin, "--yes")
    run("entire", "graph", "index", "--repo", ".", "--profile", "full")
    if run("git", "status", "--porcelain", output=True):
        print("Run 'entire brain refresh' after committing your changes to index your clean worktree.")
    else:
        run("entire", "brain", "refresh")
    run("entire", "status", "--detailed")
    print("Open a fresh Claude Code or Codex session in this checkout. In Codex, review /hooks.")


if __name__ == "__main__":
    try:
        main()
    except FileNotFoundError as error:
        sys.exit(f"Install {error.filename} and rerun setup. See prompts/team-chat.md.")
    except subprocess.CalledProcessError as error:
        sys.exit(f"Setup stopped at {error.cmd[0]} (exit {error.returncode}). Fix the error above and rerun.")
