---
name: pi-subagents
description: Delegate independent subtasks to Pi agents (any model) via the pi-subagents MCP tools. Use when the user asks for subagents, parallel agents, a second opinion from another model, or delegation.
---

Use the `pi-subagents` MCP tools instead of native subagents.

1. Call `pi_list_agents` before delegating. It lists only agents owned by this Codex conversation. Use their `lastTask`, `task`, status, result, model, working directory and tools to identify related work; inspect `pi_get_agent` when more context is needed.
2. Prefer `pi_send_followup` on a suitable `idle` agent when the work continues its task and the working directory, model and tool permissions fit. Include the new goal, relevant changes and constraints. An `error` or `aborted` agent has unfinished work: inspect its history before deciding how to recover it.
3. Spawn a new agent when there is no suitable completed agent, a different model or permissions are required, or independent tasks should run in parallel. If the user names a model or you need a choice, call `pi_list_models`. Give `pi_spawn_agent` a self-contained task, absolute `cwd`, and `tools: "read-only"` for exploration and review. When the agent works in a different directory from the parent project, set `project_dir` to the parent project so its transcript stays there. The child cannot see this conversation.
4. Call `pi_wait` with the returned ids (mode `all`, or `any` to react early). If `timedOut` is true, call it again. Use `pi_send_followup` for further instructions and `pi_abort` to stop an agent. After follow-ups finish, use `pi_get_agent` with `log_lines: 200` to inspect earlier answers: `pi_wait` returns only the latest answer. Acceptance is not proof of execution; an abort can discard queued inputs. Treat `error` or `aborted` as incomplete.
5. Tell the user the panel URL from any tool result (`panel` field) so they can watch the agents live, then summarize results and verify any file changes yourself.
