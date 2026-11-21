# Entire for the Path App team

Entire links an AI coding session to a Git commit. For example, Sam can build the upload API with Claude, push his branch, and give Arielle the checkpoint ID so she can see what the viewer should expect. Graph helps locate the code. Brain helps retrieve decisions from repository notes and checkpoint history. Start a fresh agent session for each task. A checkpoint can include your prompts, tool output and the files your agent read, so use team-shareable material and the synthetic scan fixture. In the setup below, pushing sends checkpoints to the private Path App GitHub repo.

## Set up your machine

For the shortest path, use the [team chat message and setup command](../prompts/team-chat.md). The individual commands below are useful for configuring one agent or diagnosing a setup problem.

Use Git 2.36+ and install the stable Entire CLI for your platform. For Claude capture with Brain, use Claude Code 2.1.78 or later. [Official installation guide](https://docs.entire.com/quickstart) · [Brain compatibility](https://github.com/entireio/entire-brain/releases/tag/v0.5.1)

| Platform | Command |
| --- | --- |
| macOS with Homebrew | `brew install --cask entireio/tap/entire` |
| Linux | `curl -fsSL https://entire.com/install.sh \| bash` |
| Windows PowerShell | `irm https://entire.com/install.ps1 \| iex` |

Accept the GitHub collaborator invite. If you need a fresh checkout, run `git clone https://github.com/darkprince558/path-app.git` and `cd path-app`. In an existing checkout, open a terminal in the repo root. Run `git remote get-url origin` and confirm it points to **darkprince558/path-app** before enabling capture.

```sh
entire version
entire enable --yes --agent codex --local --no-init-repo --telemetry=false --checkpoint-push-remote origin
entire agent add claude-code
entire configure --checkpoint-push-policy automatic
entire agent list
entire status
entire plugin install graph
entire plugin install brain
```

Use just the enable line with `--agent claude-code` if Claude is your only agent, and skip the add line. Open a fresh Codex CLI or Claude Code session from the repo root. In Codex, use `/hooks` to review and trust the project’s Entire hooks when prompted. Verify your session appears in `entire status` after its first turn. Stage your task files by name so machine-generated hook and settings edits stay local. [Agent setup](https://docs.entire.com/cli-reference/enable)

## Find the code and the decision

From your task worktree, try this lookup before implementing scan sharing. Graph returns ranked source locations at the current commit. Brain indexes the project docs and available checkpoint history. Refresh it manually on checkout or after pulling relevant changes. This manual workflow uses the local index without installing a watcher or starting a model-based backfill.

```sh
entire graph index --repo . --profile fast
entire graph query --repo . --head --profile fast --format agent --query "where can a guest read a private scan asset"
entire brain refresh
entire brain query "unlisted visibility viewer grants" --source doc --limit 3
```

Use `entire brain viz` for an interactive map. Give the next agent the relevant file or decision it should verify. [Graph](https://github.com/entireio/entire-graph) · [Brain](https://github.com/entireio/entire-brain)

## Hand off a real feature

1. **Owner:** Pick a brief from [agent tasks](agent-tasks.md), create a feature branch and make the change with the agent. Run the task’s checks, review the diff, stage the intended files, and commit. Accept the session-link prompt if it appears.
2. Run `git log -1 --format=%B` and look for `Entire-Checkpoint`. Review the checkpoint locally with `entire checkpoint explain --commit HEAD --full`. Check `entire checkpoint list --outgoing`, then `git push -u origin HEAD`. Send your teammate the branch, commit SHA, checkpoint ID, the check you ran, and the next action. You can confirm the ID reached GitHub with `git ls-remote origin 'refs/entire/checkpoints/*'`. If your clone uses manual checkpoint uploads, use `entire checkpoint push CHECKPOINT_ID` after review.
3. **Recipient:** From a clean checkout, run `git fetch origin` and `entire checkpoint explain CHECKPOINT_ID` using the ID from the handoff. To resume with the original agent, run `entire session resume BRANCH_NAME` before merge. If handing Claude’s work to Codex or vice versa, start the other agent on the branch and give it the checkpoint ID, acceptance test and next action. Have it inspect the checkpoint and verify the code. [Session storage](https://docs.entire.com/guides/checkpoints/checkpoint-storage) · [Resume](https://docs.entire.com/cli-reference/session)

## Optional hosted Trails and judging evidence

The team is keeping source code and checkpoint sharing on private GitHub. [The live app has its own deployment plan](deployment.md). If the team adopts hosted Trails later, Anish can connect **only** `darkprince558/path-app` under Entire’s GitHub App settings. This grants hosted Entire access to the private repo, including read/write permissions for contents and PRs. Local checkpoint setup and hosted authorization are separate steps. To create a regional mirror, run `entire login`, `entire repo mirror add /gh/darkprince558/path-app`, then `entire repo remote add entire`. [GitHub App access](https://docs.entire.com/guides/repositories/github-app-access) · [Mirrors](https://docs.entire.com/guides/repositories/mirrors)

Once the repo is connected, check **Settings → General → Trails**. Enable one review preset under **Project → Agents** for this repo. On your feature branch run `entire trail create --title "Verify unlisted scan access"` to publish and link it, then `entire trail show`. Capture the acceptance criterion, checkpoint, review finding and human decision. Mirrored repositories use the linked GitHub PR for CI and merge. [Trails guide](https://docs.entire.com/guides/trails/overview)

For the prize, compare the same lookup on the same commit and model in two fresh sessions. Keep the task, expected answer and tool access identical except for the retrieval method. Use ordinary file search in one and Graph in the other. Check both answers against the code. Save both token reports with `entire session tokens SESSION_ID --json` or compare two isolated checkpoints with `entire checkpoint tokens GRAPH_ID --compare BASELINE_ID --json`. Record session IDs, model, SHA, observed token counts, metric and answer quality. Report the measured difference, including a neutral or worse result. [Token reports](https://docs.entire.com/cli-reference/checkpoint#checkpoint-tokens)
