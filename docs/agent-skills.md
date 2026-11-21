# Entire skills for Path App

Use Entire’s **session-handoff** when a teammate takes over a task, and **review** when a second agent checks a branch against its original intent. Open Claude Code or Codex in the Path App worktree. Both workflows use the Entire CLI and gain context from a captured session or a fetched checkpoint. [Official skills and prerequisites](https://github.com/entireio/skills/tree/af6cd3fce1852a7214c43bbf64315900196ad4ee)

| When | What to ask the agent | What to save for the handoff |
| --- | --- | --- |
| Sam’s Codex session is handing the upload flow to Arielle’s Claude session | “Use Entire’s session-handoff skill for checkpoint `<id>`. Summarize the asset response shape, the last passing check, and what the viewer still needs.” | The branch, checkpoint ID and short summary. A specific checkpoint lets teammates on different machines select the same work. |
| A feature branch changes scan sharing | “Use Entire’s review skill against `origin/main`. Check that an unlisted viewer can open the shared scene, and that revoking a private viewer also blocks a direct asset read. Give me findings with file locations.” | The review findings, the owner’s response and the check result. The skill reviews the diff and can use Graph to check callers and Brain to recall decisions. |

Each teammate needs Entire CLI 0.11 or later for the handoff commands. Launch a fresh agent session after pulling the skill files. Put the checkpoint ID in the team chat or PR and keep the transcript in Entire. The handoff skill reads it as evidence and can write a temporary transcript locally. Use the share summary for the demo. [Handoff workflow](https://github.com/entireio/skills/blob/af6cd3fce1852a7214c43bbf64315900196ad4ee/skills/session-handoff/SKILL.md) · [Review workflow](https://github.com/entireio/skills/blob/af6cd3fce1852a7214c43bbf64315900196ad4ee/skills/review/SKILL.md)

## Using the bundled skills

Pull the team setup branch or the merged main branch and start a fresh agent session. In Claude, use `/entire-handoff` or `/entire-review`. In Codex, ask for the `session-handoff` or `review` skill by name and supply the checkpoint or branch. The Claude entries point to the same pinned instructions that Codex reads.

The two upstream skills and the review reference are in `.agents/skills/` at revision `af6cd3fce1852a7214c43bbf64315900196ad4ee`. Keep the [MIT notice](../.agents/skills/ENTIRE-LICENSE) when updating them. Anthropic also maintains a multi-agent PR reviewer for teams that want extra parallel reviews after the main feature works. [Anthropic’s code review plugin](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review)
