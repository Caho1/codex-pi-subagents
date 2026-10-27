---
name: pi-subagents
description: Delegate independent subtasks to Pi agents (any model) via the pi-subagents MCP tools. Use when the user asks for subagents, parallel agents, a second opinion from another model, or delegation.
---

Use the `pi-subagents` MCP tools instead of native subagents.

1. If the user names a model or you need a choice, call `pi_list_models` and pick a `provider/model` id.
2. For each independent piece of work call `pi_spawn_agent` with a self-contained `task`: goal, files or scope, constraints (e.g. "do not edit files"), and the exact output you want back. The child cannot see this conversation. Pass `cwd` as the absolute project path. Use `tools: "read-only"` for exploration and review.
3. Call `pi_wait` with the returned ids (mode `all`, or `any` to react early). If `timedOut` is true, call it again.
4. Use `pi_send_followup` to ask the same agent for fixes or details; `pi_abort` to stop one.
5. Tell the user the panel URL from any tool result (`panel` field) so they can watch the agents live, then summarize results and verify any file changes yourself.
