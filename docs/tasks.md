# Team tasks and checkpoints

Bookmark the pinned task board on your phone or laptop. It shows each owner, their latest checkpoint and its time, and the next step. If someone just posted, open their issue to read the checkpoint immediately while GitHub Actions refreshes the board. [Team task board](https://github.com/darkprince558/path-app/issues/8)

[Working now](https://github.com/darkprince558/path-app/issues?q=is%3Aissue+is%3Aopen+label%3A%22task%3Aactive%22+sort%3Aupdated-desc) · [Ready to claim](https://github.com/darkprince558/path-app/issues?q=is%3Aissue+is%3Aopen+label%3A%22task%3Aready%22+sort%3Aupdated-desc) · [My active tasks](https://github.com/darkprince558/path-app/issues?q=is%3Aissue+is%3Aopen+label%3A%22task%3Aactive%22+assignee%3A%40me+sort%3Aupdated-desc) · [Recently completed](https://github.com/darkprince558/path-app/issues?q=is%3Aissue+is%3Aclosed+reason%3Acompleted+label%3A%22task%3Aactive%22%2C%22task%3Aready%22+sort%3Aupdated-desc)

To check one teammate, open **Working now** and select their GitHub login under **Assignee**. The list sorts by the last GitHub activity. The date on the checkpoint tells you when someone last verified a result. For updates on a task you depend on, open its issue and select **Subscribe** under **Notifications**. [GitHub notification settings](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications)

## Use GitHub from your phone or laptop

1. **Pick one result.** Check the ready and active lists first. To propose new work, give it a title and one check someone else can repeat. The form adds `task:ready`. [Create a task](https://github.com/darkprince558/path-app/issues/new?template=agent-task.yml)
2. **Claim it.** Open the issue, select **assign yourself**, then under **Labels** remove `task:ready` and select `task:active`. For a code change, add the agent, branch and files you’ll edit in the issue. Give each concurrent writer their own task and worktree. [Parallel worktree commands](agent-tasks.md)
3. **Post a checkpoint.** Comment when a step works, you hit a blocker, or someone takes over. Copy the format below so teammates can see the result in the terminal too. A phone scan or device check can have its own update without a commit. Anyone with repo access can read the comment as soon as it’s posted.
4. **Finish it.** Start your final comment with `**Done**` on its own line, leave a blank line, then give the final check, its observed result and the merged PR if applicable. Select **Close as completed** and leave the task label in place. Keep the issue open when a teammate still needs to run its acceptance check.

For a quick phone update, comment `Checkpoint: what I verified` and put `Next: what happens next` on the following line. The terminal and board also recognize the longer format below.

```text
**Checkpoint**

The synthetic scan’s colored junction opens in a signed-out Safari tab.

**Next** Arielle will repeat the check with Krishna’s real phone export.
```

If a teammate picks this up later, the example records exactly which scan was tested. Link findings that change another task from the [team notebook](../knowledge/README.md). Milestones and dependencies live in the [editable roadmap](../planning/ROADMAP.md).

## Use the terminal, Claude Code or Codex

From the repository root, use Python 3 and the GitHub CLI signed in to your collaborator account (`gh auth login` on first use). On Windows, replace `python3` with `py -3`. These commands use the same GitHub issues as the browser.

```sh
# See everyone's latest work or just Sam's.
python3 scripts/tasks.py status
python3 scripts/tasks.py status --person samdeitz

# For new work, create and start your own task.
python3 scripts/tasks.py new "Render the unlisted scan" --check "A signed-out guest can see the fixture's colored junction."

# For existing work, claim its issue. Replace 12 with your actual issue number.
python3 scripts/tasks.py claim 12

# Post progress and, later, the final result on your issue.
python3 scripts/tasks.py checkpoint 12 "Opened the fixture in signed-out Safari." --next "Try the real phone export."
python3 scripts/tasks.py done 12 "Verified the real export opens on the second phone in signed-out Safari."
```

An issue checkpoint tells the team where you are. An **Entire checkpoint** saves the coding agent’s session with a Git commit so another agent can inspect or resume the work. After pushing the relevant commit from your task branch, use `--head` to attach the commit and any shared Entire checkpoint it references.

```sh
python3 scripts/tasks.py checkpoint 12 "Guest fixture test passes on this commit." --head --next "Review the guest viewer PR."
```

Ask either agent, “Read `docs/tasks.md` and the roadmap. Check active and ready tasks for overlap, then claim or create one for me to work on. Post checkpoints with the checks we actually ran and the next step.” [Set up Entire](entire.md)
