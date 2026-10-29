import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentInfo, AgentManager } from "./manager.ts";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

export function createMcpServer(mgr: AgentManager, panelUrl: string) {
	const server = new McpServer({ name: "pi-subagents", version: "0.1.0" });
	const view = (a: AgentInfo) => ({ ...a, panel: `${panelUrl}/#${a.id}` });
	// Codex attaches threadId to MCP request metadata, outside model-supplied
	// tool arguments. Fail closed when the host does not provide that identity.
	const thread = (meta: Record<string, unknown> | undefined) => {
		const id = meta?.threadId;
		if (typeof id !== "string" || !id.trim() || id.length > 256) throw new Error("Codex conversation metadata is missing; reconnect from a Codex conversation");
		return id;
	};
	const owned = (threadId: string, id: string) => {
		const live = mgr.get(id);
		// Do not reveal whether an id belongs to another conversation.
		if (live.info.codexThreadId !== threadId) throw new Error(`unknown agent ${id}`);
		return live;
	};
	const agentsFor = (threadId: string) => mgr.list().filter((a) => a.codexThreadId === threadId);

	server.registerTool(
		"pi_list_models",
		{ description: "List Pi models that have credentials. Use the returned `provider/model` id with pi_spawn_agent.", inputSchema: { include_faux: z.boolean().optional().describe("Include offline faux models when enabled on the server") } },
		async ({ include_faux }) => json(await mgr.listModels(include_faux)),
	);

	server.registerTool(
		"pi_spawn_agent",
		{
			description:
				"Start a Pi subagent on a self-contained task and return immediately with its id. " +
				"The child does not see this conversation: include goal, scope, constraints and expected output. " +
				"First check pi_list_agents and prefer pi_send_followup on a suitable completed agent for related work. " +
				"Spawn new agents for independent parallel work or incompatible model, working directory or tools. " +
				"Then call pi_wait to collect results.",
			inputSchema: {
				task: z.string().describe("Full brief for the subagent"),
				model: z.string().optional().describe("`provider/model` from pi_list_models; default = explicit model, then panel preference, then first available"),
				thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
				cwd: z.string().optional().describe("Absolute working directory; default = server cwd. Pi sessions do not inherit the Codex sandbox"),
				name: z.string().optional().describe("Short label shown in the panel"),
				tools: z.enum(["coding", "read-only"]).optional().describe("read-only = read/grep/find/ls only"),
				persist_session: z.boolean().optional().describe("Omit for server-private persistent session; true uses Pi session settings or session_dir; false keeps context in memory only and cannot resume after server restart"),
				session_dir: z.string().optional().describe("Native session directory, absolute or relative to cwd, with ~ supported; requires persist_session=true"),
				project_dir: z.string().optional().describe("Existing project directory for transcript storage; relative paths use agent cwd; defaults to agent cwd"),
			},
		},
		async ({ persist_session, session_dir, project_dir, ...options }, extra) => json(view(await mgr.spawn({ ...options, persistSession: persist_session, sessionDir: session_dir, projectDir: project_dir, codexThreadId: thread(extra._meta) }))),
	);

	server.registerTool(
		"pi_wait",
		{
			description:
				"Block until subagents finish (mode=all) or the first one finishes (mode=any), or timeout. " +
				"Returns status and final answer of each. Call again if timedOut.",
			inputSchema: {
				ids: z.array(z.string()).optional().describe("Agent ids; default = all running"),
				mode: z.enum(["any", "all"]).optional(),
				timeout_sec: z.number().min(1).max(240).optional().describe("Default 120; keep under Codex tool_timeout_sec"),
			},
		},
		async ({ ids, mode, timeout_sec }, extra) => {
			const threadId = thread(extra._meta);
			const targets = ids?.length ? ids : agentsFor(threadId).filter((a) => a.status === "running").map((a) => a.id);
			for (const id of targets) owned(threadId, id);
			if (!targets.length) return json({ timedOut: false, agents: [] });
			const r = await mgr.wait(targets, mode ?? "all", (timeout_sec ?? 120) * 1000, extra.signal);
			return json({ timedOut: r.timedOut, agents: r.agents.map(view) });
		},
	);

	server.registerTool(
		"pi_get_agent",
		{
			description: "Status, final answer and recent log of one subagent.",
			inputSchema: { id: z.string(), log_lines: z.number().min(0).max(200).optional() },
		},
		async ({ id, log_lines }, extra) => json({ ...view(owned(thread(extra._meta), id).info), log: log_lines === 0 ? [] : mgr.logOf(id).slice(-(log_lines ?? 20)) }),
	);

	server.registerTool(
		"pi_send_followup",
		{
			description: "Send another instruction to an existing subagent (keeps its context). Queued if it is still running.",
			inputSchema: { id: z.string(), message: z.string() },
		},
		async ({ id, message }, extra) => {
			owned(thread(extra._meta), id);
			return json(view(await mgr.followup(id, message)));
		},
	);

	server.registerTool(
		"pi_abort",
		{ description: "Stop a running subagent.", inputSchema: { id: z.string() } },
		async ({ id }, extra) => {
			owned(thread(extra._meta), id);
			return json(view(await mgr.abort(id)));
		},
	);

	server.registerTool(
		"pi_list_agents",
		{ description: "List only this Codex conversation's Pi subagents, including each agent's latest accepted task, status, result, model and working directory. Prefer an idle matching agent for related follow-up work." },
		async (_extra) => {
			const threadId = thread(_extra._meta);
			return json({ panel: panelUrl, codexThreadId: threadId, agents: agentsFor(threadId).sort((a, b) => b.updatedAt - a.updatedAt).map(view) });
		},
	);

	return server;
}
