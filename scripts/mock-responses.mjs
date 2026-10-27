// Fake OpenAI Responses endpoint that plays "Codex parent model" offline:
// turn 1 -> call pi_spawn_agent, turn 2 -> call pi_wait, turn 3 -> final answer quoting the Pi result.
// Lets us exercise the real Codex CLI -> MCP -> Pi path without an OpenAI login. Test-only.
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

let n = 0;
const sse = (res, events) => {
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
	res.end();
};
createServer(async (req, res) => {
	let body = "";
	for await (const c of req) body += c;
	if (!req.url.includes("/responses")) return res.writeHead(404).end();
	const j = JSON.parse(body);
	n++;
	if (process.env.MOCK_DUMP_DIR) writeFileSync(`${process.env.MOCK_DUMP_DIR}/mock-req-${n}.json`, body); // opt-in request dump for debugging
	const ns = (j.tools ?? []).find((t) => t.type === "namespace" && /pi/.test(t.name));
	const text = (o) => (typeof o === "string" ? o : o.map((c) => c.text ?? "").join("\n"));
	const outputs = (j.input ?? []).filter((i) => i.type === "function_call_output").map((i) => text(i.output));
	const id = `resp-${n}`;
	const call = (name, args) => ({ type: "response.output_item.done", item: { type: "function_call", call_id: `call-${n}`, namespace: ns?.name, name, arguments: JSON.stringify(args) } });
	const done = { type: "response.completed", response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } };
	let item;
	if (!ns) item = { type: "response.output_item.done", item: { type: "message", role: "assistant", id: `m-${n}`, content: [{ type: "output_text", text: "NO PI TOOLS VISIBLE: " + (j.tools ?? []).map((t) => t.name).join(",") }] } };
	else if (outputs.length === 0) item = call("pi_spawn_agent", { task: "Read README.md and report it", model: "faux/faux-2", cwd: process.env.DEMO_CWD ?? process.cwd(), name: "codex-child", tools: "read-only" });
	else if (outputs.length === 1) {
		const spawned = JSON.parse(outputs[0].match(/\{[\s\S]*\}/)[0]);
		item = call("pi_wait", { ids: [spawned.id], timeout_sec: 30 });
	} else item = { type: "response.output_item.done", item: { type: "message", role: "assistant", id: `m-${n}`, content: [{ type: "output_text", text: "Pi subagent finished. Raw wait output:\n" + outputs[1].slice(0, 700) }] } };
	sse(res, [{ type: "response.created", response: { id } }, item, done]);
}).listen(7799, "127.0.0.1", () => console.error("mock responses on :7799"));
