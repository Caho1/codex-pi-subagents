import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentInfo, AgentManager } from "./manager.ts";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

export function createMcpServer(mgr: AgentManager, panelUrl: string) {
	const server = new McpServer({ name: "pi-subagents", version: "0.1.0" });
	const view = (a: AgentInfo) => ({ ...a, panel: `${panelUrl}/#${a.id}` });

	server.registerTool(
		"pi_list_models",
		{ description: "List Pi models that have credentials. Use the returned `provider/model` id with pi_spawn_agent." },
		async () => json(await mgr.listModels()),
	);

	server.registerTool(
		"pi_spawn_agent",
		{
			description:
				"Start a Pi subagent on a self-contained task and return immediately with its id. " +
				"The child does not see this conversation: include goal, scope, constraints and expected output. " +
				"Then call pi_wait to collect results. Spawn several for parallel work.",
			inputSchema: {
				task: z.string().describe("Full brief for the subagent"),
				model: z.string().optional().describe("`provider/model` from pi_list_models; default = first available"),
				thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
				cwd: z.string().optional().describe("Absolute working directory; default = server cwd"),
				name: z.string().optional().describe("Short label shown in the panel"),
				tools: z.enum(["coding", "read-only"]).optional().describe("read-only = read/grep/find/ls only"),
			},
		},
		async (args) => json(view(await mgr.spawn(args))),
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
		async ({ ids, mode, timeout_sec }) => {
			const r = await mgr.wait(ids, mode ?? "all", (timeout_sec ?? 120) * 1000);
			return json({ timedOut: r.timedOut, agents: r.agents.map(view) });
		},
	);

	server.registerTool(
		"pi_get_agent",
		{
			description: "Status, final answer and recent log of one subagent.",
			inputSchema: { id: z.string(), log_lines: z.number().min(0).max(200).optional() },
		},
		async ({ id, log_lines }) => json({ ...view(mgr.get(id).info), log: mgr.logOf(id).slice(-(log_lines ?? 20)) }),
	);

	server.registerTool(
		"pi_send_followup",
		{
			description: "Send another instruction to an existing subagent (keeps its context). Queued if it is still running.",
			inputSchema: { id: z.string(), message: z.string() },
		},
		async ({ id, message }) => json(view(await mgr.followup(id, message))),
	);

	server.registerTool(
		"pi_abort",
		{ description: "Stop a running subagent.", inputSchema: { id: z.string() } },
		async ({ id }) => json(view(await mgr.abort(id))),
	);

	server.registerTool(
		"pi_list_agents",
		{ description: "All subagents with status. Also returns the web panel URL to show the user." },
		async () => json({ panel: panelUrl, agents: mgr.list().map(view) }),
	);

	return server;
}
