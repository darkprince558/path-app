# Developing Path App

Use these instructions for Codex, Claude Code, and other coding agents. If your tool needs explicit context, attach this file, the task, and the relevant component files when you start a session. The [project README](README.md) records the demo goal and team ownership.

## Start a task

Read the [architecture](docs/architecture.md) and the README for the component you are editing. The first shared milestone is uploading a real scan and opening an unlisted link on a second phone.

- Pick one outcome a teammate can verify. Record the human owner, affected components, and what success looks like in the issue or PR.
- Check current branches, open PRs, and local changes before editing. Work on a short-lived branch based on the current `main`. Give concurrent agents separate branches and worktrees or clones, with one active writer per task.
- For a change that crosses components, agree with the producer and consumer on a small example first. Keep the shared contract, its example, and callers in sync. This matters especially for scan coordinates, asset identifiers, and publication state.

## Build and verify

- Keep each change small enough for its owner to run and explain. Preserve teammates’ edits and stage only files for your task.
- Use synthetic or approved small fixtures in Git. Keep full captures, private venue images, API credentials, and signed upload URLs out of commits, coding-agent prompts, and PRs.
- Run the affected component’s documented checks. Exercise the user action that changed, recording the fixture or device used and the observed result. For cross-component changes, exercise one producer-to-consumer example.
- Describe fixture-based results, real-device checks, and outstanding tests accurately. A simulated phone scan only verifies the steps after capture.
- Run `make check` for upload, sharing, or venue fixture changes. Exercise all three sharing modes when a change affects guest access.

## Example agent handoff

> Human owner: Arielle. Build the guest scan view under `apps/web/`. Read the API workspace README and consume its share metadata and asset endpoints. An unlisted link should open signed out and show the fixture’s colored junction. Work in your assigned branch. Report the browser used, the command to reproduce, and anything that still needs a real phone.

Use the same task brief for Claude, Codex or another agent. For a review, give the second agent the diff and acceptance test and ask it to inspect the change without editing the first agent’s files.

## Hand off and merge

- Open a focused PR against `main`. Give the next teammate the branch or commit, the exact check they can rerun, and any change they must make on their side.
- The human owner reviews the diff and check results before merging. When a shared interface changes, include the affected teammate in review.
- For an unfinished task, leave the last verified step, the next action, and any blocker in the PR or issue so another agent can resume.
