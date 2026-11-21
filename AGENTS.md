# Developing Path App

## Backend direction

Sam owns a single Next.js/TypeScript backend with Tiger Data PostgreSQL, Drizzle ORM and migrations, Auth0, private Vultr Object Storage, and Gemini. Start with the [backend plan](docs/backend-plan.md), [core API contract](docs/core-api.md), and [API workspace](services/api/README.md). The database, Auth0, and core space/graph/path/event routes live in `services/api/`. Apply server-side ownership and visibility checks on every new route; never commit real credentials. The Python mock remains a fixture-only integration tool. Keep scan geometry in object storage and protect every metadata, graph and asset URL read on the server. Coordinate scan transform ordering and real export format with the capture team before finalizing that contract.

Use these instructions for Codex, Claude Code, and other coding agents. If your tool needs explicit context, attach this file, the task, and the relevant component files when you start a session. The [project README](README.md) records the demo goal and team ownership.

## Start a task

Read the [architecture](docs/architecture.md) and the README for the component you are editing. The first shared milestone is uploading a real scan and opening an unlisted link on a second phone.

- Pick one outcome a teammate can verify. Record the human owner, affected components, and what success looks like in the issue or PR.
- Check current branches, open PRs, and local changes before editing. Work on a short-lived branch based on the current `main`. Give concurrent agents separate branches and worktrees or clones, with one active writer per task.
- Claim a task in a GitHub issue or Entire Trail. Name the human owner and writable paths. Use the [parallel Claude Code and Codex workflow](docs/agent-tasks.md) for startup commands, task briefs and review.
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
- For an Entire-tracked task, include the checkpoint ID with the commit and test result. Follow the [Entire team setup](docs/entire.md) to resume the original agent or give a second agent a scoped handoff.

<!-- entire-agent:begin -->
Read .entire/agent-guide.md for this repository's workflow, source inspection, and verification guidance.
@.entire/agent-guide.md
<!-- entire-agent:end -->
