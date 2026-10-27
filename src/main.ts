import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./manager.ts";
import { createMcpServer } from "./mcp.ts";
import { installFaux } from "./faux.ts";

const { values: opt } = parseArgs({
	options: {
		port: { type: "string", default: process.env.PI_SUBAGENTS_PORT ?? "7788" },
		host: { type: "string", default: "127.0.0.1" },
		data: { type: "string", default: process.env.PI_SUBAGENTS_DATA ?? join(homedir(), ".codex-pi-subagents") },
		stdio: { type: "boolean", default: false },
		faux: { type: "boolean", default: process.env.PI_SUBAGENTS_FAUX === "1" },
	},
});

const log = (...a: unknown[]) => console.error("[pi-subagents]", ...a); // stdout is reserved for stdio MCP
const runtime = await ModelRuntime.create();
const faux = opt.faux ? installFaux(runtime) : undefined;
const mgr = new AgentManager(runtime, opt.data!, faux?.feed);
const panelUrl = `http://${opt.host}:${opt.port}`;
const panelHtml = readFileSync(new URL("./panel.html", import.meta.url), "utf8");

async function readBody(req: IncomingMessage) {
	let s = "";
	for await (const c of req) s += c;
	return s ? JSON.parse(s) : undefined;
}

function sse(res: ServerResponse) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const send = (event: string) => (data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	const handlers = { agent: send("agent"), log: send("log"), delta: send("delta") };
	for (const [k, h] of Object.entries(handlers)) mgr.on(k, h);
	send("snapshot")(mgr.list());
	const ping = setInterval(() => res.write(": ping\n\n"), 15000);
	res.on("close", () => {
		clearInterval(ping);
		for (const [k, h] of Object.entries(handlers)) mgr.off(k, h);
	});
}

const http = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", panelUrl);
	try {
		if (url.pathname === "/mcp") {
			// Stateless streamable HTTP: one server+transport per request.
			const server = createMcpServer(mgr, panelUrl);
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			res.on("close", () => { transport.close(); server.close(); });
			await server.connect(transport);
			await transport.handleRequest(req, res, req.method === "POST" ? await readBody(req) : undefined);
		} else if (url.pathname === "/api/agents") {
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(mgr.list()));
		} else if (url.pathname.startsWith("/api/agents/") && req.method === "GET") {
			const id = url.pathname.split("/")[3];
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...mgr.get(id).info, log: mgr.logOf(id) }));
		} else if (url.pathname.match(/^\/api\/agents\/\w+\/(abort|followup)$/) && req.method === "POST") {
			const [, , , id, action] = url.pathname.split("/");
			const body = await readBody(req);
			const info = action === "abort" ? await mgr.abort(id) : await mgr.followup(id, String(body?.message ?? ""));
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(info));
		} else if (url.pathname === "/api/events") {
			sse(res);
		} else if (url.pathname === "/") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(panelHtml);
		} else {
			res.writeHead(404).end("not found");
		}
	} catch (err) {
		if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: String((err as Error).message ?? err) }));
	}
});

http.on("error", (e) => log(`panel/http not started: ${e.message}`));
http.listen(Number(opt.port), opt.host, () => log(`panel ${panelUrl}  mcp ${panelUrl}/mcp${opt.faux ? "  (faux models)" : ""}`));

if (opt.stdio) await createMcpServer(mgr, panelUrl).connect(new StdioServerTransport());
