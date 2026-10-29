---
name: pi-subagents
description: Use Pi subagents for independent tasks or to continue an existing subagent's related work.
---

# Pi subagents

Before delegating, call `pi_list_agents` to find agents in the current session. Use `pi_send_followup` for related work when an existing agent has useful context. Start a new agent for independent work or when a different model, directory, or tool preset is needed.

Give each new agent a self-contained task with its goal, scope, constraints, and expected result. Use `tools: "read-only"` for research that should not modify files. Agent transcripts use the parent Pi session's working directory by default. After starting work, call `pi_wait` to collect results, and inspect them before reporting them to the user.
