import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
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
		"allow-host": { type: "string", multiple: true },
		data: { type: "string", default: process.env.PI_SUBAGENTS_DATA ?? join(homedir(), ".codex-pi-subagents") },
		stdio: { type: "boolean", default: false },
		faux: { type: "boolean", default: process.env.PI_SUBAGENTS_FAUX === "1" },
	},
});

const allowedHosts = (opt["allow-host"] ?? []).map((host) => {
	if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error(`invalid --allow-host: ${host}`);
	return host.toLowerCase();
});

const log = (...a: unknown[]) => console.error("[pi-subagents]", ...a); // stdout is reserved for stdio MCP
// 此标记只存在后台进程，防止子会话再次加载本包的委派工具。
process.env.PI_SUBAGENTS_CHILD = "1";
let mgr: AgentManager;
const require = createRequire(import.meta.url);
const vendor = (name: string, file: string) => join(dirname(require.resolve(name)), file);
const urlHost = isIP(opt.host!) === 6 ? `[${opt.host}]` : opt.host;
const panelUrl = `http://${urlHost}:${opt.port}`;
const panelHtml = readFileSync(new URL("./panel.html", import.meta.url), "utf8");
const codexAvatarsJs = readFileSync(new URL("./codex-avatars.js", import.meta.url), "utf8");
const codexIconsJs = readFileSync(new URL("./codex-icons.js", import.meta.url), "utf8");
const assetResponses: Record<string, { data: Buffer | string; type: string }> = {
	"/vendor/marked.js": { data: readFileSync(vendor("marked", "marked.umd.js")), type: "text/javascript; charset=utf-8" },
	"/vendor/mermaid.js": { data: readFileSync(vendor("mermaid", "mermaid.min.js")), type: "text/javascript; charset=utf-8" },
	"/vendor/dompurify.js": { data: readFileSync(vendor("dompurify", "purify.min.js")), type: "text/javascript; charset=utf-8" },
	"/fonts/OpenAISans-Regular-c56711d328c4.woff2": { data: readFileSync(new URL("./fonts/OpenAISans-Regular-c56711d328c4.woff2", import.meta.url)), type: "font/woff2" },
	"/fonts/OpenAISans-Medium-7b9c963f9063.woff2": { data: readFileSync(new URL("./fonts/OpenAISans-Medium-7b9c963f9063.woff2", import.meta.url)), type: "font/woff2" },
	"/fonts/OpenAISans-Semibold-e259229c5327.woff2": { data: readFileSync(new URL("./fonts/OpenAISans-Semibold-e259229c5327.woff2", import.meta.url)), type: "font/woff2" },
	"/docs/panel-deepseek.png": { data: readFileSync(new URL("../docs/panel-deepseek.png", import.meta.url)), type: "image/png" },
};

const MAX_BODY = 1024 * 1024;
async function readBody(req: IncomingMessage) {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const data = Buffer.from(chunk);
		size += data.length;
		if (size > MAX_BODY) throw Object.assign(new Error("request body exceeds 1 MiB"), { status: 413 });
		chunks.push(data);
	}
	if (!size) return undefined;
	if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw Object.assign(new Error("application/json required"), { status: 415 });
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// 同时检查 Host 和 Origin，防止浏览器跨站访问本地服务。
function allowedRequest(req: IncomingMessage) {
	const host = req.headers.host;
	if (!host) return false;
	let target: URL;
	try { target = new URL(`http://${host}`); } catch { return false; }
	const port = String((http.address() as import("node:net").AddressInfo).port);
	const configured = opt.host!.toLowerCase();
	const configuredHost = isIP(configured) === 6 ? `[${configured}]` : configured;
	const wildcard = ["0.0.0.0", "::"].includes(configured);
	const local = ["localhost", "127.0.0.1", "[::1]"];
	const machine = hostname().toLowerCase();
	const hosts = [...allowedHosts, ...(local.includes(configuredHost) || wildcard ? [...local, configuredHost, ...(wildcard ? [machine, `${machine}.local`] : [])] : [configuredHost])];
	if (!(hosts.includes(target.hostname.toLowerCase()) || (wildcard && isIP(target.hostname.replace(/^\[|\]$/g, "")))) || (target.port || "80") !== port || target.username || target.password || target.pathname !== "/") return false;
	if (req.headers.origin === undefined) return true;
	try { return new URL(req.headers.origin).origin === target.origin && req.headers.origin !== "null"; } catch { return false; }
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
	try {
		if (!mgr) { res.writeHead(503).end("service starting"); return; }
		if (!allowedRequest(req)) { res.writeHead(403).end("forbidden host or origin"); return; }
		const url = new URL(req.url ?? "/", panelUrl);
		if (url.pathname === "/mcp") {
			// Stateless streamable HTTP: one server+transport per request.
			const server = createMcpServer(mgr, panelUrl);
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			res.on("close", () => { transport.close(); server.close(); });
			await server.connect(transport);
			await transport.handleRequest(req, res, req.method === "POST" ? await readBody(req) : undefined);
		} else if (url.pathname === "/api/agents") {
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(mgr.list()));
		} else if (url.pathname === "/api/models" && req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: await mgr.listModels(), preferred: mgr.getPreferredModel() }));
		} else if (url.pathname === "/api/models" && req.method === "PUT") {
			const body = await readBody(req);
			if (!body || (body.model !== null && typeof body.model !== "string")) throw new Error("model must be a string or null");
			const preferred = await mgr.setPreferredModel(body.model);
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ preferred }));
		} else if (url.pathname.startsWith("/api/agents/") && req.method === "GET") {
			const id = url.pathname.split("/")[3];
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(mgr.detail(id)));
		} else if (url.pathname.match(/^\/api\/agents\/\w+\/(abort|followup)$/) && req.method === "POST") {
			const [, , , id, action] = url.pathname.split("/");
			const body = await readBody(req);
			if (action === "followup" && typeof body?.message !== "string") throw new Error("message must be a string");
			const info = action === "abort" ? await mgr.abort(id) : await mgr.followup(id, body.message);
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(info));
		} else if (url.pathname === "/api/events") {
			sse(res);
		} else if (url.pathname === "/codex-avatars.js") {
			res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(codexAvatarsJs);
		} else if (url.pathname === "/codex-icons.js") {
			res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(codexIconsJs);
		} else if (url.pathname in assetResponses) {
			const asset = assetResponses[url.pathname]!;
			res.writeHead(200, { "content-type": asset.type }).end(asset.data);
		} else if (url.pathname === "/") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(panelHtml);
		} else {
			res.writeHead(404).end("not found");
		}
	} catch (err) {
		if (!res.headersSent) res.writeHead((err as { status?: number }).status ?? 400, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: String((err as Error).message ?? err) }));
	}
});

// 先占用监听端口，再打开数据目录，避免竞争进程创建第二个管理器。
await new Promise<void>((resolve, reject) => {
	http.once("error", reject);
	http.listen(Number(opt.port), opt.host, () => { http.off("error", reject); resolve(); });
});
http.on("error", (error) => log(`http error: ${error.message}`));
const runtime = await ModelRuntime.create();
const faux = opt.faux ? installFaux(runtime) : undefined;
mgr = new AgentManager(runtime, opt.data!, faux?.feed, !!opt.faux);
log(`panel ${panelUrl}  mcp ${panelUrl}/mcp${opt.faux ? "  (faux models)" : ""}`);

if (opt.stdio) await createMcpServer(mgr, panelUrl).connect(new StdioServerTransport());

// 先停止接收请求，再释放每个会话的扩展和 MCP 连接。
let shutdown: Promise<void> | undefined;
function closeService() {
	return shutdown ??= (async () => {
		http.close();
		http.closeAllConnections();
		await mgr.close();
	})();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => { void closeService().then(() => process.exit(0), (error) => { log("shutdown failed", error); process.exit(1); }); });
}
if (opt.stdio) process.stdin.once("end", () => { void closeService(); });
