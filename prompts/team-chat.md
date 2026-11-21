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

Check that `entire status --detailed` lists Claude Code, Codex and `origin`. Claim your issue, create your task branch, then start `claude` or `codex`. In Codex, open `/hooks` and approve the Entire hooks. Use a fresh project-only chat. Pushed checkpoints include prompts and tool output. When you hand off, post your branch, checkpoint ID and passing check.

[Editable roadmap and assignments](https://github.com/darkprince558/path-app/blob/main/planning/ROADMAP.md) · [Parallel worktree commands](https://github.com/darkprince558/path-app/blob/main/docs/agent-tasks.md)
