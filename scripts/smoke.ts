// End-to-end check over real MCP (streamable HTTP): spawn two agents on different models, wait, follow up.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://127.0.0.1:7788/mcp";
const cwd = process.argv[2] ?? process.cwd();
const fauxOnly = process.env.SMOKE_FAUX === "1";
const TASK = process.env.TASK ?? "Use the read tool to read README.md in the working directory, then summarize it in 3 short bullet points.";
const FOLLOWUP = process.env.FOLLOWUP ?? "Follow-up: in one sentence, which Node.js version does it require, and where did you see that?";
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const call = async (name: string, args: Record<string, unknown> = {}) => {
	const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
	if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
	return JSON.parse(r.content[0].text);
};

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
const available = await call("pi_list_models", fauxOnly ? { include_faux: true } : {}) as { id: string }[];
const models = fauxOnly ? available.filter((m) => m.id.startsWith("faux/")) : available;
if (!models.length) throw new Error(fauxOnly ? "no faux models; start server with --faux" : "no available models");
console.log("models:", models.map((m: { id: string }) => m.id).join(", "));
const a = await call("pi_spawn_agent", { task: TASK, model: models[0].id, cwd, name: "scout-a", tools: "read-only" });
const b = await call("pi_spawn_agent", { task: TASK, model: models.at(-1).id, cwd, name: "scout-b", tools: "read-only" });
console.log("spawned:", a.id, a.model, a.status, "|", b.id, b.model, b.status, "| panel:", a.panel);
const w = await call("pi_wait", { ids: [a.id, b.id], timeout_sec: 230 });
if (w.timedOut || w.agents.some((x: { status: string }) => x.status !== "idle")) throw new Error(`spawn failed: ${JSON.stringify(w)}`);
for (const x of w.agents) console.log("done:", x.id, x.status, x.turns, "turns", JSON.stringify(x.result?.slice(0, 400)));
await call("pi_send_followup", { id: a.id, message: FOLLOWUP });
const w2 = await call("pi_wait", { ids: [a.id], timeout_sec: 230 });
if (w2.timedOut || w2.agents[0]?.status !== "idle") throw new Error(`followup failed: ${JSON.stringify(w2)}`);
const f = w2.agents[0];
console.log("followup:", f.status, f.turns, "turns", JSON.stringify(f.result?.slice(0, 300)));
for (const x of [f, ...w.agents.slice(1)]) console.log("usage:", x.id, x.model, x.tokens, "$" + x.cost.toFixed(5));
const g = await call("pi_get_agent", { id: a.id, log_lines: 10 });
console.log("log kinds:", g.log.map((l: { kind: string }) => l.kind).join(" "));
await client.close();
