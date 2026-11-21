# Running Claude Code and Codex together

Use one GitHub issue per outcome. [Create or claim a task](tasks.md) with your name, agent, branch and files before editing. The [team board](https://github.com/darkprince558/path-app/issues/8) shows planned tasks (`task:ready`), work in progress (`task:active`) and recently completed issues. Post a checkpoint when you verify a step, hit a blocker or hand off. Name the next action and who can take it.

## Start two sessions

Install both agent CLIs you intend to run and follow the [Entire setup](entire.md). Run the following from a clone of Path App. The [editable roadmap](../planning/ROADMAP.md) shows the current milestone and dependencies. These example branches let Arielle’s viewer and Sam’s API progress independently. If someone already claimed either task, choose another.

```sh
git fetch origin
git worktree add -b feature/guest-viewer ../path-web origin/main
git worktree add -b feature/scan-api ../path-api origin/main
```

Open two terminals in the original clone. Complete the setup commands in the first before running setup in the second, since worktrees share Git hooks. Each agent starts from the root of its own worktree. On Windows use `py -3 scripts/setup_entire.py` for the setup command.

**Terminal 1 — Claude Code**

```sh
cd ../path-web
python3 scripts/setup_entire.py
claude
```

**Terminal 2 — Codex**

```sh
cd ../path-api
python3 scripts/setup_entire.py
codex
```

Confirm the intended agent hooks and checkpoint destination in each status report. Give each session its own brief from the table. An individual teammate can use either CLI for any task. To run both agents on one feature, give one write ownership and the other a read-only review of a specific pushed commit. [Entire agent and Git hooks](https://docs.entire.com/guides/configuration/git-hooks)

## First tasks to claim

Start with the open [guest viewer](https://github.com/darkprince558/path-app/issues/2), [persistent upload API](https://github.com/darkprince558/path-app/issues/3), [capture trial](https://github.com/darkprince558/path-app/issues/4), and [second-phone acceptance run](https://github.com/darkprince558/path-app/issues/5). Record the active writer and branch on the issue when you start.

| Human owner | Agent brief and write scope | Evidence for the handoff |
| --- | --- | --- |
| Arielle | “Build the upload and guest view in `apps/web/` against the documented API. Open an unlisted fixture link in a signed-out session and render its colored points.” | Guest URL path, browser and screenshot of the junction. |
| Sam | “Implement persistent scan upload and share lookup in `services/api/`. Keep the existing response shapes, default privacy and asset-level read checks. Exercise a restart.” | A repeatable upload and read, byte match, access checks and the same URL after restart. |
| Krishna | “Document the phone’s capture and export settings in `apps/capture/`. After my device trial, use my measured file size, encoding, axes and distance to describe the sample.” | Device, exporter, export preset and measurements. A human records the scan. |
| Anish | “Prepare a second-phone acceptance procedure in `docs/phone-trial.md` for one real upload. Record which landmark and known distance the guest should recognize. Leave observations open until I run it.” | Device, browser, first interactive load time, landmark and scale observations from the real phone. |

**Agree on the interface first.** Sam and Arielle use the [API example](../services/api/README.md) for the 201 response, metadata lookup and authorized asset path. Krishna gives them the actual format and byte size. Anish and Arielle agree which turn the guest needs to recognize. If a field, format or axis changes, the producer posts one example in the task and names the affected consumer before both branches adopt it.

## Review and hand off

Commit and push a scoped change after the agent has edited files. Use `python3 scripts/tasks.py checkpoint N "Observed result" --head --next "Next action"` with your issue number. It attaches the pushed commit and its shared Entire checkpoint when present. Include the verification command or device used so the next person can repeat the check.

The reviewer fetches the branch and inspects the pushed change against the acceptance test, e.g. `git diff origin/main...origin/feature/guest-viewer -- apps/web`. Ask the reviewer to report a reproducible issue or the result of the test. The human owner resolves findings and decides when to merge.

For a teammate using the original agent, run `entire session resume BRANCH` in a clean worktree. For Claude-to-Codex or Codex-to-Claude, give the receiving agent the task link, checkpoint ID and next action. Ask it to inspect `entire checkpoint explain CHECKPOINT_ID` and run the named check before it changes code. [Entire session handoffs](https://docs.entire.com/learn/skills#session-handoff)
