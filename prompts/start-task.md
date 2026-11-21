# Start a Path App task

Paste this into a fresh Claude Code or Codex session in your task's worktree. Replace the four bracketed fields.

> I'm [name], working on [issue URL] on branch [branch]. My writable scope is [paths]. Read AGENTS.md, the issue, and the relevant section of planning/ROADMAP.md. Tell me the acceptance check and any dependency another teammate owns. Implement the scoped change, run the check, then give me a handoff with the files changed, actual result, any remaining device test, and the next action. If the interface needs to change, show the producer and consumer the proposed example first.

For a second agent reviewing the change:

> Review [branch or commit] against [issue URL] in read-only mode. Use Entire checkpoint [ID] for the original intent. Check the acceptance result against the diff and report any reproducible issue with a file location. The task owner handles edits and merge.
