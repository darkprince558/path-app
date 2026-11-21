# Start a Path App task

Paste this into a fresh Claude Code or Codex session in your task's worktree. Replace the four bracketed fields.

> I'm [name], working on [issue URL] on branch [branch]. My writable scope is [paths]. Read AGENTS.md, the issue, and the relevant section of planning/ROADMAP.md. Tell me the acceptance check and any dependency another teammate owns. Implement the scoped change, run the check, then give me a handoff with the files changed, actual result, any remaining device test, and the next action. If the interface needs to change, show the producer and consumer the proposed example first.

If you have an idea and need a task first, paste this into Claude or Codex with your outcome filled in.

> I want to [outcome]. Read docs/tasks.md and check the live issues for overlap. Claim the matching task if it is available to me, or create and assign me a new one with one observable acceptance check. Post a checkpoint on the issue whenever we verify a step or hit a blocker. Include what we actually observed and what comes next. Close it when the acceptance check passes.

For a second agent reviewing the change:

> Review [branch or commit] against [issue URL] in read-only mode. Use Entire checkpoint [ID] for the original intent. Check the acceptance result against the diff and report any reproducible issue with a file location. The task owner handles edits and merge.
