# Paste this in the team chat

Hey team, Entire is on `main`. It lets us pass work between Claude and Codex with the context behind each commit. You'll need Git, Python 3, and whichever agent you use. Install Entire once with the line for your computer.

- **macOS with Homebrew:** `brew install --cask entireio/tap/entire`
- **Linux:** `curl -fsSL https://entire.com/install.sh | bash`
- **Windows PowerShell:** `irm https://entire.com/install.ps1 | iex`

**First time cloning the repo?**

```sh
git clone https://github.com/darkprince558/path-app.git
cd path-app
```

**Already have it?** From your clean checkout:

```sh
git switch main
git pull --ff-only origin main
```

**Then run one command** from the repo root:

- **macOS/Linux:** `python3 scripts/setup_entire.py`
- **Windows:** `py -3 scripts/setup_entire.py`

Check that `entire status --detailed` lists Claude Code, Codex and `origin`. Start `claude` or `codex` on your task branch. In Codex, open `/hooks` and approve the Entire hooks. Use a fresh project-only chat. Pushed Entire checkpoints include prompts and tool output.

Bookmark the [team board](https://github.com/darkprince558/path-app/issues/8). It shows who’s doing what and their latest checkpoint. [Create a task from your phone](https://github.com/darkprince558/path-app/issues/new?template=agent-task.yml), or use the terminal with [GitHub CLI](https://cli.github.com/) installed. Sign in once with `gh auth login`. Replace 12 with your issue number and use your actual result.

```sh
python3 scripts/tasks.py status
python3 scripts/tasks.py new "My task" --check "How someone can tell it works"
python3 scripts/tasks.py checkpoint 12 "What I verified" --next "What happens next"
python3 scripts/tasks.py done 12 "Final check and result"
```

For an existing ticket, run `python3 scripts/tasks.py claim 12`. On Windows use `py -3` in place of `python3`. From a phone, just comment `Checkpoint: what I verified` on your issue. Add `Next: what happens next` on a new line.

[Editable roadmap and assignments](https://github.com/darkprince558/path-app/blob/main/planning/ROADMAP.md) · [Parallel worktree commands](https://github.com/darkprince558/path-app/blob/main/docs/agent-tasks.md)
