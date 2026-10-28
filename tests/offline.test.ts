import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { request } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentManager } from "../src/manager.ts";
import { installFaux } from "../src/faux.ts";
import { createMcpServer } from "../src/mcp.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-test-config-"));
const threadA = "00000000-0000-4000-8000-000000000001";
const threadB = "00000000-0000-4000-8000-000000000002";
process.env.PI_CODING_AGENT_DIR = testAgentDir;
after(async () => {
 if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
 else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
 await rm(testAgentDir, { recursive: true, force: true });
});

async function within<T>(promise: Promise<T>, label: string, ms = 10000): Promise<T> {
 let timer: NodeJS.Timeout | undefined;
 try {
  return await Promise.race([
   promise,
   new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
  ]);
 } finally {
  clearTimeout(timer);
 }
}

async function port() {
 const server = createServer(); server.listen(0, "127.0.0.1");
  await within(once(server, "listening"), "port allocation");
 const n = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r())); return n;
}

test("offline MCP, HTTP boundaries and persisted follow-up", async () => {
 const dir = await mkdtemp(join(tmpdir(), "pi-bridge-"));
 const n = await port();
  const base = `http://127.0.0.1:${n}`;
 const start = () => spawn(process.execPath, ["--import", "tsx", "src/main.ts", "--faux", "--port", String(n), "--data", dir], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
 let child = start();
 const ready = () => within(new Promise<void>((resolve, reject) => {
  child.stderr.on("data", (data) => { if (String(data).includes("panel http")) resolve(); });
  child.once("exit", (code) => reject(new Error(`server exited ${code}`)));
 }), "server startup");
 const stop = async () => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await within(exited, "server exit");
 };
 try {
  await ready();
  const models = await (await fetch(`${base}/api/models`)).json() as { models: { id: string }[] };
  assert(!models.models.some((m) => m.id.startsWith("faux/")));
  assert.equal((await fetch(`${base}/api/agents/x/abort`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "text/plain" } })).status, 403);
  const badHost = await new Promise<number>((resolve, reject) => { const req = request(`${base}/api/agents`, { headers: { host: `evil.example:${n}` } }, (res) => { res.resume(); resolve(res.statusCode!); }); req.on("error", reject); req.end(); });
  assert.equal(badHost, 403);
  assert.equal((await fetch(`${base}/api/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "x".repeat(1024 * 1024) }) })).status, 413);
  const client = new Client({ name: "offline", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const call = async (name: string, args: object) => { const result = await client.callTool({ name, arguments: args, _meta: { threadId: threadA } }) as { content: { text: string }[]; isError?: boolean };
  assert(!result.isError, result.content[0]?.text); return JSON.parse(result.content[0]!.text); };
  const defaultModels = await call("pi_list_models", {});
  assert(!defaultModels.some((m: { id: string }) => m.id.startsWith("faux/")));
  const mcpModels = await call("pi_list_models", { include_faux: true });
  assert(mcpModels.some((m: { id: string }) => m.id === "faux/faux-1"));
  const agent = await call("pi_spawn_agent", { task: "read", model: "faux/faux-1", cwd: process.cwd(), tools: "read-only" });
  assert.equal(agent.codexThreadId, threadA);
  assert.equal(agent.lastTask, "read");
  await Promise.all([
   call("pi_send_followup", { id: agent.id, message: "queued first" }),
   call("pi_send_followup", { id: agent.id, message: "queued second" }),
  ]);
  const done = await call("pi_wait", { ids: [agent.id], timeout_sec: 30 });
  assert.equal(done.agents[0].status, "idle");
  const userMessages = SessionManager.open(agent.sessionFile).getEntries()
   .filter((entry) => entry.type === "message" && entry.message.role === "user")
   .map((entry) => JSON.stringify(entry));
  assert.equal(userMessages.filter((message) => message.includes("queued first")).length, 1);
  assert.equal(userMessages.filter((message) => message.includes("queued second")).length, 1);
  assert.deepEqual((await call("pi_get_agent", { id: agent.id, log_lines: 0 })).log, []);
  await call("pi_send_followup", { id: agent.id, message: "again" });
  const next = await call("pi_wait", { ids: [agent.id], timeout_sec: 30 });
  assert.equal(next.agents[0].status, "idle");
  assert(next.agents[0].turns > done.agents[0].turns);
  assert.equal(next.agents[0].lastTask, "again");
  await client.close();
  await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/smoke.ts", process.cwd()], { env: { ...process.env, MCP_URL: `${base}/mcp`, SMOKE_FAUX: "1" }, timeout: 30000 });
  await stop(); child = start();
  await ready();
  const restored = new Client({ name: "offline-restart", version: "1" });
  await restored.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const send = async (name: string, args: object) => { const result = await restored.callTool({ name, arguments: args, _meta: { threadId: threadA } }) as { content: { text: string }[]; isError?: boolean };
  assert(!result.isError, result.content[0]?.text); return JSON.parse(result.content[0]!.text); };
  const reopened = await send("pi_get_agent", { id: agent.id });
  assert.equal(reopened.status, "idle");
  assert.equal(reopened.codexThreadId, threadA);
  assert.equal(reopened.lastTask, "again");
  await Promise.all([
   send("pi_send_followup", { id: agent.id, message: "after restart one" }),
   send("pi_send_followup", { id: agent.id, message: "after restart two" }),
  ]);
  const afterRestart = await send("pi_wait", { ids: [agent.id], timeout_sec: 30 });
  assert.equal(afterRestart.agents[0].status, "idle");
  assert(afterRestart.agents[0].turns > next.agents[0].turns);
  const restoredMessages = SessionManager.open(agent.sessionFile).getEntries()
   .filter((entry) => entry.type === "message" && entry.message.role === "user")
   .map((entry) => JSON.stringify(entry));
  assert.equal(restoredMessages.filter((message) => message.includes("after restart one")).length, 1);
  assert.equal(restoredMessages.filter((message) => message.includes("after restart two")).length, 1);
  await restored.close();
 } finally { await stop();
  await rm(dir, { recursive: true, force: true }); }
});

test("bad index is preserved and faux discovery is opt-in", async () => {
 const dir = await mkdtemp(join(tmpdir(), "pi-index-"));
 try {
  const file = join(dir, "agents.json");
  await writeFile(file, "{broken");
  const runtime = await ModelRuntime.create(); installFaux(runtime);
  assert.throws(() => new AgentManager(runtime, dir), /invalid agent index/);
  assert.equal(await readFile(file, "utf8"), "{broken");
  await rm(file);
  const hidden = new AgentManager(runtime, dir);
  assert(!(await hidden.listModels()).some((m) => m.id.startsWith("faux/")));
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test("MCP scopes all agent operations to the calling Codex conversation", async () => {
 const dir = await mkdtemp(join(tmpdir(), "pi-conversation-scope-"));
 let client: Client | undefined;
 let server: ReturnType<typeof createMcpServer> | undefined;
 try {
  const runtime = await ModelRuntime.create();
  const manager = new AgentManager(runtime, dir);
  const add = (id: string, codexThreadId: string | undefined, status: string) => {
   const info = { id, name: id, task: `initial ${id}`, lastTask: `latest ${id}`, codexThreadId, model: "faux/faux-1", thinking: "off", cwd: dir, tools: "read-only", status, createdAt: 1, updatedAt: 1, turns: 0, tokens: { input: 0, output: 0 }, cost: 0 };
   (manager as any).agents.set(id, { info, log: [{ t: 1, kind: "user", text: `private ${id}` }], draft: "", revision: 0 });
  };
  add("agent-a", threadA, "idle");
  add("agent-b", threadB, "running");
  add("legacy", undefined, "idle");
  server = createMcpServer(manager, "http://127.0.0.1");
  client = new Client({ name: "scope-regression", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: object, threadId?: string) => client!.callTool({ name, arguments: args, ...(threadId ? { _meta: { threadId } } : {}) }) as Promise<{ content: { text: string }[]; isError?: boolean }>;
  const visibleA = await call("pi_list_agents", {}, threadA);
  const visibleB = await call("pi_list_agents", {}, threadB);
  assert(!visibleA.isError && !visibleB.isError);
  const a = JSON.parse(visibleA.content[0]!.text);
  const b = JSON.parse(visibleB.content[0]!.text);
  assert.equal(a.codexThreadId, threadA);
  assert.deepEqual(a.agents.map((x: { id: string }) => x.id), ["agent-a"]);
  assert.equal(a.agents[0].lastTask, "latest agent-a");
  assert.deepEqual(b.agents.map((x: { id: string }) => x.id), ["agent-b"]);
  const ownDetail = await call("pi_get_agent", { id: "agent-a" }, threadA);
  assert.match(ownDetail.content[0]!.text, /private agent-a/);
  for (const [name, args] of [
   ["pi_get_agent", { id: "agent-b" }],
   ["pi_get_agent", { id: "legacy" }],
   ["pi_send_followup", { id: "agent-b", message: "do not deliver", threadId: threadB }],
   ["pi_abort", { id: "agent-b" }],
   ["pi_wait", { ids: ["agent-a", "agent-b"], timeout_sec: 1 }],
  ] as const) {
   const result = await call(name, args, threadA);
   assert(result.isError, `${name} must reject another conversation's agent`);
   assert.match(result.content[0]!.text, /unknown agent/);
   assert(!result.content[0]!.text.includes("private agent-b"));
  }
  const emptyWait = await call("pi_wait", {}, threadA);
  assert.deepEqual(JSON.parse(emptyWait.content[0]!.text), { timedOut: false, agents: [] });
  for (const [name, args] of [["pi_list_agents", {}], ["pi_spawn_agent", { task: "missing scope" }], ["pi_get_agent", { id: "agent-a" }], ["pi_wait", {}]] as const) {
   const result = await call(name, args);
   assert(result.isError, `${name} must fail closed without conversation metadata`);
   assert.match(result.content[0]!.text, /conversation metadata is missing/);
  }
  assert.equal(manager.get("agent-b").info.status, "running");
 } finally {
  await client?.close();
  await server?.close();
  await rm(dir, { recursive: true, force: true });
 }
});

test("abort waits for SDK completion and wait cancellation leaves agent running", async () => {
 const dir = await mkdtemp(join(tmpdir(), "pi-abort-"));
 try {
  const runtime = await ModelRuntime.create();
  const manager = new AgentManager(runtime, dir);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const info = { id: "test", name: "test", task: "", model: "", thinking: "off", cwd: dir, tools: "read-only", status: "running", createdAt: 1, updatedAt: 1, turns: 0, tokens: { input: 0, output: 0 }, cost: 0 };
  const session = { clearQueue() {}, async abort() { calls++;
  await gate; }, isStreaming: true };
  (manager as any).agents.set(info.id, { info, session, log: [], draft: "", revision: 0 });
  const controller = new AbortController();
  const cancelled = manager.wait([info.id], "all", 10000, controller.signal);
  controller.abort();
  await assert.rejects(cancelled);
  assert.equal(info.status, "running");
  const first = manager.abort(info.id);
  const second = manager.abort(info.id);
  const wait = manager.wait([info.id], "all", 10000);
  let completed = false;
  void wait.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(info.status, "running");
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal((await wait).agents[0]!.status, "aborted");
  assert.equal(calls, 2);
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test("failed abort does not report an active agent stopped", async () => {
 const dir = await mkdtemp(join(tmpdir(), "pi-abort-fail-"));
 try {
  const manager = new AgentManager(await ModelRuntime.create(), dir);
  const info = { id: "test", status: "running", createdAt: 1 };
  (manager as any).agents.set(info.id, { info, session: { clearQueue() {}, abort: async () => { throw new Error("abort failed"); }, isStreaming: true }, log: [], draft: "", revision: 0 });
  await assert.rejects(manager.abort(info.id), /abort failed/);
  assert.equal(info.status, "running");
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test("model selection uses the complete available model identity", async () => {
 const dir = await mkdtemp(join(tmpdir(), "pi-model-"));
 try {
  const first = { provider: "a", id: "vendor/model", name: "one" };
  const second = { provider: "b", id: "vendor/model", name: "two" };
  const runtime = { getAvailable: async () => [first, second] } as unknown as ModelRuntime;
  const manager = new AgentManager(runtime, dir);
  assert.equal(await (manager as any).resolveModel(), first);
  assert.equal(await (manager as any).resolveModel("b/vendor/model"), second);
  await assert.rejects((manager as any).resolveModel("vendor/model"), /ambiguous/);
  await manager.setPreferredModel("b/vendor/model");
  assert.equal(await (manager as any).resolveModel(), second);
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing saved session is not recreated and interrupted agents are not replayed", async () => {
 const dir = await mkdtemp(join(tmpdir(), "pi-restore-"));
 try {
  const file = join(dir, "sessions", "missing.jsonl");
  const info = { id: "old", status: "running", createdAt: 1, sessionFile: file };
  await writeFile(join(dir, "agents.json"), JSON.stringify([info]));
  const manager = new AgentManager(await ModelRuntime.create(), dir);
  assert.equal(manager.get("old").info.status, "error");
  await assert.rejects(manager.followup("old", "continue"), /missing/);
  await assert.rejects(readFile(file));
 } finally { await rm(dir, { recursive: true, force: true }); }
});

function deferred() { let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

async function fauxModel(runtime: ModelRuntime) {
 const model = (await runtime.getAvailable("faux")).find((m) => m.id === "faux-1");
 assert.ok(model, "faux test model must be available");
 return model;
}

test("a successful queued follow-up cannot mask a failed original task", async () => {
 const { createAgentSession, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
 const { fauxProvider, fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
 const dir = await mkdtemp(join(tmpdir(), "pi-failed-original-"));
 const entered = deferred(), release = deferred(), queued = deferred();
 let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
 let client: Client | undefined;
 let server: ReturnType<typeof createMcpServer> | undefined;
 try {
  const runtime = await ModelRuntime.create();
  const faux = fauxProvider({ provider: "fault", models: [{ id: "fault-model" }], tokensPerSecond: 1000 });
  faux.setResponses([
   async () => { entered.resolve(); await release.promise; return fauxAssistantMessage([], { stopReason: "error", errorMessage: "original request failed" }); },
   fauxAssistantMessage(fauxText("queued follow-up answered")),
   fauxAssistantMessage(fauxText("explicit recovery answered")),
  ]);
  runtime.registerNativeProvider(faux.provider);
  const model = (await runtime.getAvailable("fault"))[0];
  assert.ok(model);
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: dir, model, modelRuntime: runtime, sessionManager: SessionManager.inMemory(), resourceLoader: loader, noTools: true }));
  await session.bindExtensions({});
  session.subscribe((event) => { if (event.type === "queue_update" && event.followUp.includes("queued follow-up")) queued.resolve(); });
  const manager = new AgentManager(runtime, dir);
  const info = { id: "fault", name: "fault", task: "", codexThreadId: threadA, model: "fault/fault-model", thinking: "off", cwd: dir, tools: "read-only", status: "idle", createdAt: 1, updatedAt: 1, turns: 0, tokens: { input: 0, output: 0 }, cost: 0 };
  const live = { info, log: [], draft: "", revision: 0 };
  (manager as any).agents.set(info.id, live); (manager as any).attach(live, session);
  server = createMcpServer(manager, "http://127.0.0.1");
  client = new Client({ name: "fault-regression", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: object) => {
   const response = await client!.callTool({ name, arguments: args, _meta: { threadId: threadA } }) as { content: { text: string }[]; isError?: boolean };
   assert(!response.isError, response.content[0]?.text);
   return JSON.parse(response.content[0]!.text);
  };
  await call("pi_send_followup", { id: info.id, message: "original request" });
  await within(entered.promise, "original request entered model");
  await call("pi_send_followup", { id: info.id, message: "queued follow-up" });
  await within(queued.promise, "follow-up queued");
  release.resolve();
  const failed = await call("pi_wait", { ids: [info.id], timeout_sec: 10 });
  assert.equal(failed.timedOut, false);
  assert.equal(failed.agents[0].status, "error");
  assert.match(failed.agents[0].error, /original request failed/);
  const detail = await call("pi_get_agent", { id: info.id, log_lines: 200 });
  assert(detail.log.some((line: { kind: string; text: string }) => line.kind === "assistant" && line.text === "queued follow-up answered"));
  await call("pi_send_followup", { id: info.id, message: "explicit recovery" });
  const recovered = await call("pi_wait", { ids: [info.id], timeout_sec: 10 });
  assert.equal(recovered.agents[0].status, "idle");
  assert.equal(recovered.agents[0].result, "explicit recovery answered");
 } finally {
  release.resolve();
  await client?.close();
  await server?.close();
  session?.dispose();
  await rm(dir, { recursive: true, force: true });
 }
});

test("a follow-up arriving after an error but before settlement preserves that failure", async () => {
 const { createAgentSession, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
 const { fauxProvider, fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
 const dir = await mkdtemp(join(tmpdir(), "pi-error-settling-"));
 const entered = deferred(), release = deferred();
 let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
 let settlements = 0;
 try {
  const runtime = await ModelRuntime.create();
  const faux = fauxProvider({ provider: "settling-fault", models: [{ id: "fault-model" }], tokensPerSecond: 1000 });
  faux.setResponses([
   fauxAssistantMessage([], { stopReason: "error", errorMessage: "failed before settlement" }),
   fauxAssistantMessage(fauxText("later follow-up answered")),
  ]);
  runtime.registerNativeProvider(faux.provider);
  const model = (await runtime.getAvailable("settling-fault"))[0];
  assert.ok(model);
  const loader = new DefaultResourceLoader({
   cwd: dir, agentDir: dir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
   extensionFactories: [(pi) => { pi.on("agent_settled", async () => {
    if (++settlements === 1) { entered.resolve(); await release.promise; }
   }); }],
  });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: dir, model, modelRuntime: runtime, sessionManager: SessionManager.inMemory(), resourceLoader: loader, noTools: true }));
  await session.bindExtensions({});
  const manager = new AgentManager(runtime, dir);
  const info = { id: "fault", name: "fault", task: "", model: "settling-fault/fault-model", thinking: "off", cwd: dir, tools: "read-only", status: "idle", createdAt: 1, updatedAt: 1, turns: 0, tokens: { input: 0, output: 0 }, cost: 0 };
  const live = { info, log: [], draft: "", revision: 0 };
  (manager as any).agents.set(info.id, live); (manager as any).attach(live, session);
  await manager.followup(info.id, "original request");
  await within(entered.promise, "error settlement barrier");
  assert.equal(info.status, "running");
  await manager.followup(info.id, "later follow-up");
  release.resolve();
  const done = await manager.wait([info.id], "all", 10000);
  assert.equal(done.timedOut, false);
  assert.equal(done.agents[0]!.status, "error");
  assert.match(done.agents[0]!.error!, /failed before settlement/);
  assert(manager.logOf(info.id).some((line) => line.kind === "assistant" && line.text === "later follow-up answered"));
 } finally {
  release.resolve();
  session?.dispose();
  await rm(dir, { recursive: true, force: true });
 }
});

test("a failed preflight is not masked by a queued follow-up", async () => {
 const { createAgentSession, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
 const { fauxProvider, fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
 const dir = await mkdtemp(join(tmpdir(), "pi-preflight-failure-"));
 const entered = deferred(), release = deferred();
 let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
 try {
  const runtime = await ModelRuntime.create();
  const faux = fauxProvider({ provider: "preflight-fault", models: [{ id: "fault-model" }], tokensPerSecond: 1000 });
  faux.setResponses([fauxAssistantMessage(fauxText("queued follow-up answered"))]);
  runtime.registerNativeProvider(faux.provider);
  const model = (await runtime.getAvailable("preflight-fault"))[0];
  assert.ok(model);
  const loader = new DefaultResourceLoader({
   cwd: dir, agentDir: dir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
   extensionFactories: [(pi) => { pi.on("input", async (event) => {
    if (event.text === "original request") {
     entered.resolve(); await release.promise;
     runtime.unregisterProvider("preflight-fault");
     await runtime.refresh({ allowNetwork: false });
    } else if (event.text === "queued follow-up") {
     runtime.registerNativeProvider(faux.provider);
     await runtime.refresh({ allowNetwork: false });
    }
    return { action: "continue" };
   }); }],
  });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: dir, model, modelRuntime: runtime, sessionManager: SessionManager.inMemory(), resourceLoader: loader, noTools: true }));
  await session.bindExtensions({});
  const manager = new AgentManager(runtime, dir);
  const info = { id: "fault", name: "fault", task: "", model: "preflight-fault/fault-model", thinking: "off", cwd: dir, tools: "read-only", status: "idle", createdAt: 1, updatedAt: 1, turns: 0, tokens: { input: 0, output: 0 }, cost: 0 };
  const live = { info, log: [], draft: "", revision: 0 };
  (manager as any).agents.set(info.id, live); (manager as any).attach(live, session);
  await manager.followup(info.id, "original request");
  await within(entered.promise, "input preflight barrier");
  await manager.followup(info.id, "queued follow-up");
  release.resolve();
  const done = await manager.wait([info.id], "all", 10000);
  assert.equal(done.timedOut, false);
  assert.equal(done.agents[0]!.status, "error");
  assert.match(done.agents[0]!.error!, /No API key found/);
  assert(manager.logOf(info.id).some((line) => line.kind === "assistant" && line.text === "queued follow-up answered"));
 } finally {
  release.resolve();
  session?.dispose();
  await rm(dir, { recursive: true, force: true });
 }
});

test("a successful Pi automatic retry can complete the original task before a queued follow-up", async () => {
 const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
 const { fauxProvider, fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
 const dir = await mkdtemp(join(tmpdir(), "pi-retry-success-"));
 const entered = deferred(), release = deferred(), queued = deferred();
 let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
 try {
  const runtime = await ModelRuntime.create();
  const faux = fauxProvider({ provider: "retry", models: [{ id: "retry-model" }], tokensPerSecond: 1000 });
  faux.setResponses([
   async () => { entered.resolve(); await release.promise; return fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 rate limit" }); },
   fauxAssistantMessage(fauxText("original completed after retry")),
   fauxAssistantMessage(fauxText("queued follow-up answered")),
  ]);
  runtime.registerNativeProvider(faux.provider);
  const model = (await runtime.getAvailable("retry"))[0];
  assert.ok(model);
  const settings = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: dir, model, modelRuntime: runtime, sessionManager: SessionManager.inMemory(), settingsManager: settings, resourceLoader: loader, noTools: true }));
  await session.bindExtensions({});
  let retrySucceeded = false;
  session.subscribe((event) => {
   if (event.type === "auto_retry_end" && event.success) retrySucceeded = true;
   if (event.type === "queue_update" && event.followUp.includes("queued follow-up")) queued.resolve();
  });
  const manager = new AgentManager(runtime, dir);
  const info = { id: "retry", name: "retry", task: "", model: "retry/retry-model", thinking: "off", cwd: dir, tools: "read-only", status: "idle", createdAt: 1, updatedAt: 1, turns: 0, tokens: { input: 0, output: 0 }, cost: 0 };
  const live = { info, log: [], draft: "", revision: 0 };
  (manager as any).agents.set(info.id, live); (manager as any).attach(live, session);
  await manager.followup(info.id, "original request");
  await within(entered.promise, "original request entered model");
  await manager.followup(info.id, "queued follow-up");
  await within(queued.promise, "follow-up queued");
  release.resolve();
  const done = await manager.wait([info.id], "all", 10000);
  assert.equal(done.timedOut, false);
  assert.equal(retrySucceeded, true);
  assert.equal(done.agents[0]!.status, "idle");
  assert.equal(done.agents[0]!.result, "queued follow-up answered");
  assert(manager.logOf(info.id).some((line) => line.kind === "assistant" && line.text === "original completed after retry"));
 } finally {
  release.resolve();
  session?.dispose();
  await rm(dir, { recursive: true, force: true });
 }
});

test("real Pi input barrier prevents wait from reporting abort before startup stops", async () => {
 const { createAgentSession, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
 const dir = await mkdtemp(join(tmpdir(), "pi-input-"));
  const entered = deferred();
  const release = deferred();
  let inputs = 0;
 try {
  const runtime = await ModelRuntime.create();
  const faux = installFaux(runtime);
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => { pi.on("input", async () => { if (++inputs === 1) { entered.resolve();
  await release.promise; } return { action: "continue" }; }); }] });
  await loader.reload();
  const model = await fauxModel(runtime);
  const { session } = await createAgentSession({ cwd: dir, model, modelRuntime: runtime, sessionManager: SessionManager.inMemory(), resourceLoader: loader, noTools: true });
  await session.bindExtensions({});
  const manager = new AgentManager(runtime, dir, faux.feed, true);
  const info = { id: "test", name: "test", task: "", model: "faux/faux-1", thinking: "off", cwd: dir, tools: "read-only", status: "running", createdAt: 1, updatedAt: 1, turns: 0, tokens: { input: 0, output: 0 }, cost: 0 };
  const live = { info, log: [], draft: "", revision: 0 }; (manager as any).agents.set(info.id, live); (manager as any).attach(live, session); (manager as any).run(live, "hello");
  await within(entered.promise, "input barrier");
  await Promise.all([manager.followup(info.id, "queued one"), manager.followup(info.id, "queued two")]);
  const stopping = manager.abort(info.id);
  const wait = manager.wait([info.id], "all", 10000);
  let done = false;
  void wait.then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(info.status, "running");
  release.resolve();
  await within(stopping, "agent abort");
  assert.equal((await wait).agents[0]!.status, "aborted");
  assert.equal(session.isStreaming, false);
  assert.equal(inputs, 1, "abort must discard follow-ups waiting behind input preprocessing");
  await manager.followup(info.id, "after abort");
  assert.equal((await manager.wait([info.id], "all", 10000)).agents[0]!.status, "idle");
  assert(session.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("after abort")));
  session.dispose();
 } finally { release.resolve();
  await rm(dir, { recursive: true, force: true }); }
});

test("real Pi simultaneous follow-ups across input preprocessing", async () => {
 const { createAgentSession, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
 const dir = await mkdtemp(join(tmpdir(), "pi-concurrent-"));
  const entered = deferred();
  const release = deferred();
  let count = 0;
 try {
  const runtime = await ModelRuntime.create();
  const faux = installFaux(runtime);
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => { pi.on("input", async () => { if (++count === 1) { entered.resolve();
  await release.promise; } return { action: "continue" }; }); }] });
  await loader.reload();
  const model = await fauxModel(runtime);
  const { session } = await createAgentSession({ cwd: dir, model, modelRuntime: runtime, sessionManager: SessionManager.inMemory(), resourceLoader: loader, noTools: true });
  await session.bindExtensions({});
  const manager = new AgentManager(runtime, dir, faux.feed, true);
  const info = { id: "test", name: "test", task: "", model: "faux/faux-1", thinking: "off", cwd: dir, tools: "read-only", status: "idle", createdAt: 1, updatedAt: 1, turns: 0, tokens: { input: 0, output: 0 }, cost: 0 };
  const live = { info, log: [], draft: "", revision: 0 }; (manager as any).agents.set(info.id, live); (manager as any).attach(live, session);
  await Promise.all([manager.followup(info.id, "one"), manager.followup(info.id, "two"), manager.followup(info.id, "three")]);
  await within(entered.promise, "input barrier");
  assert.equal(count, 1);
  const waiting = manager.wait([info.id], "all", 30000);
  let completed = false;
  void waiting.then(() => { completed = true; });
  await Promise.resolve();
  assert.equal(completed, false);
  release.resolve();
  const done = await waiting;
  assert.equal(done.timedOut, false);
  assert.equal(done.agents[0]!.status, "idle");
  const messages = session.messages.filter((m) => m.role === "user").map((m) => m.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
  assert.deepEqual(messages, ["one", "two", "three"]);
  session.dispose();
 } finally { release.resolve();
  await rm(dir, { recursive: true, force: true }); }
});

test("follow-up reaches Pi's queue while the current agent is running", async () => {
 const { createAgentSession, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
 const dir = await mkdtemp(join(tmpdir(), "pi-running-followup-"));
 const entered = deferred();
 const release = deferred();
 const queued = deferred();
 try {
  await writeFile(join(dir, "README.md"), "fixture");
  const runtime = await ModelRuntime.create();
  const faux = installFaux(runtime);
  const loader = new DefaultResourceLoader({
   cwd: dir, agentDir: dir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
   extensionFactories: [(pi) => { pi.on("tool_call", async (event) => {
    if (event.toolName === "read") { entered.resolve(); await release.promise; }
   }); }],
  });
  await loader.reload();
  const model = await fauxModel(runtime);
  const { session } = await createAgentSession({ cwd: dir, model, modelRuntime: runtime, sessionManager: SessionManager.inMemory(), resourceLoader: loader });
  await session.bindExtensions({});
  session.subscribe((event) => { if (event.type === "queue_update" && event.followUp.includes("supplement")) queued.resolve(); });
  const manager = new AgentManager(runtime, dir, faux.feed, true);
  const info = { id: "test", name: "test", task: "", model: "faux/faux-1", thinking: "off", cwd: dir, tools: "read-only", status: "idle", createdAt: 1, updatedAt: 1, turns: 0, tokens: { input: 0, output: 0 }, cost: 0 };
  const live = { info, log: [], draft: "", revision: 0 };
  (manager as any).agents.set(info.id, live); (manager as any).attach(live, session);
  await manager.followup(info.id, "first");
  await within(entered.promise, "active tool call");
  await manager.followup(info.id, "supplement");
  await within(queued.promise, "follow-up queued while running");
  assert.equal(session.isStreaming, true);
  release.resolve();
  const done = await manager.wait([info.id], "all", 10000);
  assert.equal(done.timedOut, false);
  assert.equal(done.agents[0]!.status, "idle");
  const messages = session.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
  assert.equal(messages.filter((m) => m.includes("supplement")).length, 1);
  session.dispose();
 } finally {
  release.resolve();
  await rm(dir, { recursive: true, force: true });
 }
});

test("follow-up waits safely when the previous Pi run is settling", async () => {
 const { createAgentSession, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
 const dir = await mkdtemp(join(tmpdir(), "pi-settling-followup-"));
 const entered = deferred();
 const release = deferred();
 let settlements = 0;
 try {
  const runtime = await ModelRuntime.create();
  const faux = installFaux(runtime);
  const loader = new DefaultResourceLoader({
   cwd: dir, agentDir: dir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
   extensionFactories: [(pi) => { pi.on("agent_settled", async () => {
    if (++settlements === 1) { entered.resolve(); await release.promise; }
   }); }],
  });
  await loader.reload();
  const model = await fauxModel(runtime);
  const { session } = await createAgentSession({ cwd: dir, model, modelRuntime: runtime, sessionManager: SessionManager.inMemory(), resourceLoader: loader, noTools: true });
  await session.bindExtensions({});
  const manager = new AgentManager(runtime, dir, faux.feed, true);
  const info = { id: "test", name: "test", task: "", model: "faux/faux-1", thinking: "off", cwd: dir, tools: "read-only", status: "idle", createdAt: 1, updatedAt: 1, turns: 0, tokens: { input: 0, output: 0 }, cost: 0 };
  const live = { info, log: [], draft: "", revision: 0 };
  (manager as any).agents.set(info.id, live); (manager as any).attach(live, session);
  await manager.followup(info.id, "first");
  await within(entered.promise, "settling barrier");
  assert.equal(session.isStreaming, false);
  await manager.followup(info.id, "during settling");
  const waiting = manager.wait([info.id], "all", 10000);
  release.resolve();
  const done = await waiting;
  assert.equal(done.timedOut, false);
  assert.equal(done.agents[0]!.status, "idle");
  const messages = session.messages.filter((m) => m.role === "user").map((m) => JSON.stringify(m.content));
  assert.equal(messages.filter((m) => m.includes("during settling")).length, 1);
  session.dispose();
 } finally {
  release.resolve();
  await rm(dir, { recursive: true, force: true });
 }
});

test("real Pi input handled by extension settles without agent events", async () => {
 const { createAgentSession, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
 const dir = await mkdtemp(join(tmpdir(), "pi-handled-"));
 try {
  const runtime = await ModelRuntime.create(); installFaux(runtime);
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(pi) => { pi.on("input", async () => ({ action: "handled" })); }] });
  await loader.reload();
  const model = await fauxModel(runtime);
  const { session } = await createAgentSession({ cwd: dir, model, modelRuntime: runtime, sessionManager: SessionManager.inMemory(), resourceLoader: loader });
  await session.bindExtensions({});
  const manager = new AgentManager(runtime, dir);
  const info = { id: "test", name: "test", task: "", model: "", thinking: "off", cwd: dir, tools: "read-only", status: "idle", createdAt: 1, updatedAt: 1, turns: 0, tokens: { input: 0, output: 0 }, cost: 0 };
  const live = { info, log: [], draft: "", revision: 0 }; (manager as any).agents.set(info.id, live); (manager as any).attach(live, session);
  await manager.followup(info.id, "handled");
  const result = await manager.wait([info.id], "all", 1000);
  assert.equal(result.timedOut, false);
  assert.equal(result.agents[0]!.status, "idle");
  session.dispose();
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real Pi extension abort produces aborted and a later run resets it", async () => {
 const { createAgentSession, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
 const dir = await mkdtemp(join(tmpdir(), "pi-extension-abort-"));
 try {
  const runtime = await ModelRuntime.create();
  const faux = installFaux(runtime);
  let cancel = true;
  const loader = new DefaultResourceLoader({
   cwd: dir, agentDir: dir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
   extensionFactories: [(pi) => {
    pi.on("message_update", (_event, ctx) => {
     if (cancel) { cancel = false; ctx.abort(); }
    });
   }],
  });
  await loader.reload();
  const model = await fauxModel(runtime);
  const { session } = await createAgentSession({ cwd: dir, model, modelRuntime: runtime, sessionManager: SessionManager.inMemory(), resourceLoader: loader, noTools: true });
  await session.bindExtensions({});
  const manager = new AgentManager(runtime, dir, faux.feed, true);
  const info = { id: "test", name: "test", task: "", model: "faux/faux-1", thinking: "off", cwd: dir, tools: "read-only", status: "idle", createdAt: 1, updatedAt: 1, turns: 0, tokens: { input: 0, output: 0 }, cost: 0 };
  const live = { info, log: [], draft: "", revision: 0 };
  (manager as any).agents.set(info.id, live);
  (manager as any).attach(live, session);
  await manager.followup(info.id, "first");
  const first = await manager.wait([info.id], "all", 10000);
  assert.equal(first.timedOut, false);
  assert.equal(first.agents[0]!.status, "aborted");
  assert.equal(session.isStreaming, false);
  await manager.followup(info.id, "next");
  const next = await manager.wait([info.id], "all", 10000);
  assert.equal(next.timedOut, false);
  assert.equal(next.agents[0]!.status, "idle");
  session.dispose();
 } finally {
  await rm(dir, { recursive: true, force: true });
 }
});

test("wildcard binding accepts only explicitly allowed custom hostnames", async () => {
 const dir = await mkdtemp(join(tmpdir(), "pi-host-"));
 const n = await port();
 const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "--faux", "--host", "0.0.0.0", "--allow-host", "bridge.example", "--port", String(n), "--data", dir], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
 try {
  await within(new Promise<void>((resolve, reject) => {
   child.stderr.on("data", (data) => { if (String(data).includes("panel http")) resolve(); });
   child.once("exit", (code) => reject(new Error(`server exited ${code}`)));
  }), "server startup");
  const status = (host: string, origin?: string) => new Promise<number>((resolve, reject) => {
   const req = request(`http://127.0.0.1:${n}/api/agents`, { headers: { host: `${host}:${n}`, ...(origin ? { origin } : {}) } }, (res) => { res.resume(); resolve(res.statusCode!); });
   req.on("error", reject); req.end();
  });
  assert.equal(await status("bridge.example", `http://bridge.example:${n}`), 200);
  assert.equal(await status("other.example"), 403);
  assert.equal(await status("bridge.example", "https://evil.example"), 403);
 } finally {
  if (child.exitCode === null && child.signalCode === null) {
   const exited = once(child, "exit"); child.kill(); await within(exited, "server exit");
  }
  await rm(dir, { recursive: true, force: true });
 }
});

test("model listings preserve real models and expose faux only to opted-in MCP", async () => {
 const dir = await mkdtemp(join(tmpdir(), "pi-model-list-"));
 try {
  const runtime = {
   getAvailable: async () => [
    { provider: "real", id: "model", name: "Real", reasoning: false, contextWindow: 100 },
    { provider: "faux", id: "faux-1", name: "Faux", reasoning: false, contextWindow: 100 },
   ],
  } as unknown as ModelRuntime;
  const enabled = new AgentManager(runtime, dir, () => {}, true);
  assert.deepEqual((await enabled.listModels()).map((m) => m.id), ["real/model"]);
  assert.deepEqual((await enabled.listModels(true)).map((m) => m.id), ["real/model", "faux/faux-1"]);
  const disabled = new AgentManager(runtime, dir);
  assert.deepEqual((await disabled.listModels(true)).map((m) => m.id), ["real/model"]);
 } finally {
  await rm(dir, { recursive: true, force: true });
 }
});
