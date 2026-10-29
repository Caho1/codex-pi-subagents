import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/manager.ts";
import { AgentTranscript } from "../src/transcript.ts";
import { installFaux } from "../src/faux.ts";

const root = mkdtempSync(join(tmpdir(), "pi-transcript-test-"));
process.env.PI_CODING_AGENT_DIR = join(root, "config");
test.after(() => rmSync(root, { recursive: true, force: true }));
const rows = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("project files preserve complete messages, permissions and git ignore", () => {
 const project = join(root, "project"); mkdirSync(project); execFileSync("git", ["init", "-q", project]);
 const writer = AgentTranscript.create(project, "abc", project);
 const message = { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "toolCall", arguments: { long: "x".repeat(1000) } }] };
 writer.append(message); writer.append({ role: "toolResult", content: [{ type: "text", text: "y".repeat(1000) }] }); writer.close();
 assert.deepEqual(rows(writer.file)[0].message, message);
 assert.equal(rows(writer.file)[1].message.content[0].text.length, 1000);
 assert.equal(statSync(writer.file).mode & 0o777, 0o600);
 execFileSync("git", ["-C", project, "check-ignore", "-q", writer.file]);
 writeFileSync(writer.file, "{partial");
 assert.throws(() => AgentTranscript.open(writer.file, "abc", project), /incomplete/);
 assert.equal(readFileSync(writer.file, "utf8"), "{partial");
});

test("memory session reopens with context and restart refuses it", async () => {
 const project = join(root, "memory"); const data = join(root, "data"); mkdirSync(project); mkdirSync(data);
 writeFileSync(join(project, "README.md"), "fixture");
 const runtime = await ModelRuntime.create(); const faux = installFaux(runtime);
 const models = await runtime.getAvailable("faux"); runtime.getAvailable = async () => models; const manager = new AgentManager(runtime, data, faux.feed, true);
 const agent = await manager.spawn({ task: "same", cwd: project, tools: "read-only", persistSession: false });
 await manager.wait([agent.id], "all", 30000); assert.equal(agent.status, "idle"); assert.equal(agent.sessionFile, undefined);
 await manager.followup(agent.id, "same"); await manager.wait([agent.id], "all", 30000); await manager.close();
 const records = rows(agent.transcriptFile!);
 assert.deepEqual(records.filter((r) => r.type === "user").map((r) => r.message.content[0].text), ["same", "same"]);
 assert(records.some((r) => r.type === "toolResult"));
 const restored = new AgentManager(runtime, data); assert(restored.detail(agent.id).log.length > 0);
 await assert.rejects(restored.followup(agent.id, "again"), /无法恢复上下文/); await restored.close();
});

test("session policies validate and persist in expected directories", async () => {
 const project = join(root, "policies"); const data = join(root, "policies-data"); mkdirSync(project); mkdirSync(data); writeFileSync(join(project, "README.md"), "fixture");
 const runtime = await ModelRuntime.create(); const faux = installFaux(runtime); const models = await runtime.getAvailable("faux"); runtime.getAvailable = async () => models; const manager = new AgentManager(runtime, data, faux.feed, true);
 await assert.rejects(manager.spawn({ task: "bad", cwd: project, sessionDir: "foo" }), /requires/);
 const a = await manager.spawn({ task: "default", cwd: project, tools: "read-only" });
 const b = await manager.spawn({ task: "custom", cwd: project, tools: "read-only", persistSession: true, sessionDir: "sessions" });
 await manager.wait([a.id, b.id], "all", 30000); await manager.close();
 assert(a.sessionFile!.startsWith(join(data, "sessions"))); assert(b.sessionFile!.startsWith(join(project, "sessions")));
});

test("legacy import preserves existing files and imports complete native entries", async () => {
 const project = join(root, "legacy"); const data = join(root, "legacy-data"); mkdirSync(project); mkdirSync(data); writeFileSync(join(project, "README.md"), "fixture");
 const runtime = await ModelRuntime.create(); const faux = installFaux(runtime); const models = await runtime.getAvailable("faux"); runtime.getAvailable = async () => models;
 const manager = new AgentManager(runtime, data, faux.feed, true); const agent = await manager.spawn({ task: "before", cwd: project, tools: "read-only" });
 await manager.wait([agent.id], "all", 30000); await manager.close();
 const oldPath = agent.transcriptFile!; const oldData = readFileSync(oldPath, "utf8");
 delete agent.transcriptFile; delete agent.nativeSession; delete agent.projectDir;
 writeFileSync(join(data, "agents.json"), JSON.stringify([agent]));
 const restored = new AgentManager(runtime, data, faux.feed, true);
 await restored.followup(agent.id, "after"); await restored.wait([agent.id], "all", 30000); await restored.close();
 assert(readFileSync(oldPath, "utf8").startsWith(oldData));
 assert.deepEqual(rows(oldPath).filter((r) => r.type === "user").map((r) => r.message.content[0].text), ["before", "after"]);
});

test("write failure does not escape event listener or prevent native append", async () => {
 const project = join(root, "failure"); const data = join(root, "failure-data"); mkdirSync(project); mkdirSync(data); writeFileSync(join(project, "README.md"), "fixture");
 const runtime = await ModelRuntime.create(); const faux = installFaux(runtime); const models = await runtime.getAvailable("faux"); runtime.getAvailable = async () => models;
 const manager = new AgentManager(runtime, data, faux.feed, true);
 const agent = await manager.spawn({ task: "failure", cwd: project, tools: "read-only" });
 const live = manager.get(agent.id) as any;
 live.transcript.append = () => { throw new Error("disk failed"); };
 await manager.wait([agent.id], "all", 30000); await manager.close();
 assert.match(agent.transcriptError!, /disk failed/); assert.equal(agent.status, "error");
 assert(readFileSync(agent.sessionFile!, "utf8").includes('"type":"message"'));
});

test("memory runtime releases and reconnects MCP, retains context and records handled input", async () => {
 const project = join(root, "mcp-project"), data = join(root, "mcp-data"), config = join(root, "mcp-config"), marker = join(root, "mcp-marker");
 mkdirSync(project); mkdirSync(data); mkdirSync(config); writeFileSync(marker, "");
 const oldConfig = process.env.PI_CODING_AGENT_DIR, oldMarker = process.env.PI_TEST_MARKER;
 process.env.PI_CODING_AGENT_DIR = config; process.env.PI_TEST_MARKER = marker;
 writeFileSync(join(config, "settings.json"), JSON.stringify({ extensions: [resolve("tests/fixtures/pi-extension.mjs")] }));
 writeFileSync(join(config, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [resolve("tests/fixtures/pi-mcp.mjs")], exposure: "direct" } } }));
 const runtime = await ModelRuntime.create(); const faux = fauxProvider({ provider: "faux", models: [{ id: "fixture" }], tokensPerSecond: 10000 }); runtime.registerNativeProvider(faux.provider);
 const available = runtime.getAvailable.bind(runtime); runtime.getAvailable = (provider, options) => available(provider ?? "faux", options);
 const manager = new AgentManager(runtime, data);
 const waitMarker = async (value: string, count: number) => {
  for (let i = 0; i < 100; i++) { if (readFileSync(marker, "utf8").split(value).length - 1 >= count) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`missing ${value} ${count}`);
 };
 try {
  const agent = await manager.spawn({ task: "handled fixture", cwd: project, model: "faux/fixture", persistSession: false });
  await manager.wait([agent.id], "all", 10000); await waitMarker("extension-stop", 1);
  assert(rows(agent.transcriptFile!).some((r) => r.type === "handled" && r.message.text === "handled fixture"));
  faux.appendResponses([fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", {}), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("first answer"))]);
  await manager.followup(agent.id, "first actual input"); await manager.wait([agent.id], "all", 10000); await waitMarker("mcp-stop", 1);
  let context = "";
  faux.appendResponses([fauxAssistantMessage(fauxToolCall("mcp__fixture__echo", {}), { stopReason: "toolUse" }), (ctx) => { context = JSON.stringify(ctx.messages); return fauxAssistantMessage(fauxText("context checked")); }]);
  await manager.followup(agent.id, "second actual input"); await manager.wait([agent.id], "all", 10000); await waitMarker("mcp-stop", 2);
  assert.match(context, /first actual input/); assert.match(context, /mcp-result/); assert.match(context, /first answer/);
  assert.equal(readFileSync(marker, "utf8").split("mcp-start").length - 1, 2);
  assert.equal(agent.sessionFile, undefined);
  await manager.close();
  const restored = new AgentManager(runtime, data); assert(restored.detail(agent.id).log.some((line) => line.text === "handled fixture"));
  await assert.rejects(restored.followup(agent.id, "restart"), /无法恢复上下文/); await restored.close();
 } finally {
  await manager.close();
  if (oldConfig === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldConfig;
  if (oldMarker === undefined) delete process.env.PI_TEST_MARKER; else process.env.PI_TEST_MARKER = oldMarker;
 }
});

test("concurrent identical followups each become exactly one finalized message", async () => {
 const project = join(root, "concurrent"), data = join(root, "concurrent-data"); mkdirSync(project); mkdirSync(data); writeFileSync(join(project, "README.md"), "fixture");
 const runtime = await ModelRuntime.create(); const faux = installFaux(runtime); const models = await runtime.getAvailable("faux"); runtime.getAvailable = async () => models;
 const manager = new AgentManager(runtime, data, faux.feed, true);
 const agent = await manager.spawn({ task: "initial", cwd: project, tools: "read-only", persistSession: false });
 await manager.wait([agent.id], "all", 30000);
 await Promise.all([manager.followup(agent.id, "repeat"), manager.followup(agent.id, "repeat")]);
 await manager.wait([agent.id], "all", 30000); await manager.close();
 assert.deepEqual(rows(agent.transcriptFile!).filter((r) => r.type === "user").map((r) => r.message.content[0].text), ["initial", "repeat", "repeat"]);
});

test("Pi extension forwards options through actual MCP and defaults project to parent cwd", async () => {
 const project = join(root, "pi-parent"), childCwd = join(root, "pi-child"), data = join(root, "pi-server-data"), config = join(root, "pi-server-config");
 mkdirSync(project); mkdirSync(childCwd); mkdirSync(data); mkdirSync(config); writeFileSync(join(childCwd, "README.md"), "fixture");
 const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
 const port = (probe.address() as { port: number }).port; await new Promise<void>((r) => probe.close(() => r()));
 const server = spawn(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/main.ts"), "--faux", "--port", String(port), "--data", data], { cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: config }, stdio: ["ignore", "ignore", "pipe"] });
 const oldPort = process.env.PI_SUBAGENTS_PORT; process.env.PI_SUBAGENTS_PORT = String(port);
 try {
  await new Promise<void>((resolveReady, reject) => {
   const timer = setTimeout(() => reject(new Error("server startup timed out")), 10000);
   server.stderr.on("data", (chunk) => { if (String(chunk).includes("panel http")) { clearTimeout(timer); resolveReady(); } });
   server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
  });
  const { default: extension } = await import("../packages/pi/extension.js");
  const registered = new Map<string, any>(); extension({ registerTool: (tool: any) => registered.set(tool.name, tool) });
  const tool = registered.get("pi_spawn_agent"); assert(tool.parameters.properties.persist_session); assert(tool.parameters.properties.session_dir); assert(tool.parameters.properties.project_dir);
  const context = { cwd: project, sessionManager: { getSessionId: () => "test-session" } };
  const response = await tool.execute("call", { task: "fixture", model: "faux/faux-1", cwd: childCwd, tools: "read-only", persist_session: false }, undefined, undefined, context);
  const agent = JSON.parse(response.content[0].text);
  assert.equal(agent.projectDir, project); assert.equal(agent.cwd, childCwd); assert.equal(agent.nativeSession.mode, "memory");
  assert.equal(agent.transcriptFile, AgentTranscript.path(project, agent.id));
  const custom = await tool.execute("call2", { task: "fixture", model: "faux/faux-1", cwd: childCwd, tools: "read-only", persist_session: true, session_dir: "sessions", project_dir: childCwd }, undefined, undefined, context);
  const other = JSON.parse(custom.content[0].text);
  assert.equal(other.projectDir, childCwd); assert(other.sessionFile.startsWith(join(childCwd, "sessions")));
 } finally {
  server.kill("SIGTERM"); await once(server, "exit");
  if (oldPort === undefined) delete process.env.PI_SUBAGENTS_PORT; else process.env.PI_SUBAGENTS_PORT = oldPort;
 }
});

test("transcript close failure marks only that agent and keeps native sessions", async () => {
 const project = join(root, "close-failure"), data = join(root, "close-failure-data"); mkdirSync(project); mkdirSync(data); writeFileSync(join(project, "README.md"), "fixture");
 const runtime = await ModelRuntime.create(); const faux = installFaux(runtime); const models = await runtime.getAvailable("faux"); runtime.getAvailable = async () => models;
 const manager = new AgentManager(runtime, data, faux.feed, true);
 const broken = await manager.spawn({ task: "broken", cwd: project, tools: "read-only" });
 const live = manager.get(broken.id) as any; const close = live.transcript.close.bind(live.transcript);
 live.transcript.close = () => { close(); throw new Error("simulated fsync failure"); };
 const other = await manager.spawn({ task: "other", cwd: project, tools: "read-only" });
 await manager.wait([broken.id, other.id], "all", 30000); await manager.close();
 assert.equal(broken.status, "error"); assert.match(broken.transcriptError!, /simulated fsync failure/);
 assert.equal(other.status, "idle"); assert(readFileSync(broken.sessionFile!, "utf8").includes('"type":"message"')); assert(readFileSync(other.sessionFile!, "utf8").includes('"type":"message"'));
});

test("legacy import retries after damaged target is removed without poisoning agent state", async () => {
 const project = join(root, "legacy-retry"), data = join(root, "legacy-retry-data"); mkdirSync(project); mkdirSync(data); writeFileSync(join(project, "README.md"), "fixture");
 const runtime = await ModelRuntime.create(); const faux = installFaux(runtime); const models = await runtime.getAvailable("faux"); runtime.getAvailable = async () => models;
 const manager = new AgentManager(runtime, data, faux.feed, true); const agent = await manager.spawn({ task: "old turn", cwd: project, tools: "read-only" });
 await manager.wait([agent.id], "all", 30000); await manager.close();
 const target = agent.transcriptFile!; writeFileSync(target, "{broken"); delete agent.transcriptFile; delete agent.nativeSession; delete agent.projectDir;
 writeFileSync(join(data, "agents.json"), JSON.stringify([agent]));
 const restored = new AgentManager(runtime, data, faux.feed, true);
 await assert.rejects(restored.followup(agent.id, "not recorded"), /incomplete/);
 assert.equal(readFileSync(target, "utf8"), "{broken"); assert.equal(restored.get(agent.id).info.transcriptError, undefined);
 rmSync(target); await restored.followup(agent.id, "new turn"); await restored.wait([agent.id], "all", 30000); await restored.close();
 assert.equal(restored.get(agent.id).info.status, "idle");
 assert.deepEqual(rows(target).filter((r) => r.type === "user").map((r) => r.message.content[0].text), ["old turn", "new turn"]);
});

test("successful followup after transcript failure keeps warning but reports current success", async () => {
 const project = join(root, "failure-retry"), data = join(root, "failure-retry-data"); mkdirSync(project); mkdirSync(data); writeFileSync(join(project, "README.md"), "fixture");
 const runtime = await ModelRuntime.create(); const faux = installFaux(runtime); const models = await runtime.getAvailable("faux"); runtime.getAvailable = async () => models;
 const manager = new AgentManager(runtime, data, faux.feed, true);
 const agent = await manager.spawn({ task: "first", cwd: project, tools: "read-only" });
 const live = manager.get(agent.id) as any; live.transcript.append = () => { throw new Error("first disk failure"); };
 await manager.wait([agent.id], "all", 30000);
 assert.equal(agent.status, "error"); const warning = agent.transcriptError; assert.match(warning!, /first disk failure/);
 await manager.followup(agent.id, "second"); await manager.wait([agent.id], "all", 30000);
 assert.equal(agent.status, "idle"); assert.equal(agent.transcriptError, warning); assert.equal(agent.error, undefined);
 assert(rows(agent.transcriptFile!).some((r) => r.type === "user" && r.message.content[0].text === "second"));
 await manager.followup(agent.id, "third");
 const close = live.transcript.close.bind(live.transcript);
 live.transcript.close = () => { close(); throw new Error("second disk failure"); };
 await manager.wait([agent.id], "all", 30000); await manager.close();
 assert.equal(agent.status, "error"); assert.match(agent.error!, /second disk failure/); assert.equal(agent.transcriptError, warning);
});

test("damaged transcript remains readable in part and is reported on restore", async () => {
 const project = join(root, "damaged-restore"), data = join(root, "damaged-restore-data"); mkdirSync(project); mkdirSync(data);
 const writer = AgentTranscript.create(project, "damaged", project); writer.append({ role: "user", content: [{ type: "text", text: "prior message" }] }); writer.append({ role: "user", content: "plain text message" }); writer.close();
 writeFileSync(writer.file, readFileSync(writer.file, "utf8") + "{incomplete");
 writeFileSync(join(data, "agents.json"), JSON.stringify([{ id: "damaged", name: "damaged", task: "", model: "", thinking: "off", cwd: project, tools: "read-only", status: "idle", createdAt: 1, updatedAt: 1, turns: 0, tokens: { input: 0, output: 0 }, cost: 0, nativeSession: { mode: "memory" }, transcriptFile: writer.file }]));
 const runtime = await ModelRuntime.create(); const manager = new AgentManager(runtime, data); const agent = manager.detail("damaged");
 assert.equal(agent.status, "error"); assert.match(agent.transcriptError!, /incomplete/); assert(agent.log.some((line) => line.text === "prior message"));
 assert(agent.log.some((line) => line.text === "plain text message"));
 await manager.close();
});

test("Pi session directory precedence honors project settings and leaves private and memory policies unchanged", async () => {
 const project = join(root, "config-priority"), data = join(root, "config-priority-data"), config = join(root, "config-priority-agent");
 mkdirSync(project); mkdirSync(data); mkdirSync(config); mkdirSync(join(project, ".pi")); mkdirSync(join(project, "other-project"));
 writeFileSync(join(project, "README.md"), "fixture");
 const globalDir = join(root, "global-sessions"), projectDir = join(root, "project-sessions"), envDir = join(root, "env-sessions"), explicitDir = join(root, "explicit-sessions");
 const oldConfig = process.env.PI_CODING_AGENT_DIR, oldSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
 process.env.PI_CODING_AGENT_DIR = config;
 delete process.env.PI_CODING_AGENT_SESSION_DIR;
 writeFileSync(join(config, "settings.json"), JSON.stringify({ sessionDir: globalDir }));
 writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ sessionDir: projectDir }));
 const runtime = await ModelRuntime.create(); const faux = installFaux(runtime); const models = await runtime.getAvailable("faux"); runtime.getAvailable = async () => models;
 const manager = new AgentManager(runtime, data, faux.feed, true);
 try {
  const spawn = async (opts: { persistSession?: boolean; sessionDir?: string; projectDir?: string }) => {
   const info = await manager.spawn({ task: "test", cwd: project, tools: "read-only", ...opts });
   await manager.wait([info.id], "all", 30000); return info;
  };
  process.env.PI_CODING_AGENT_SESSION_DIR = envDir;
  const explicit = await spawn({ persistSession: true, sessionDir: explicitDir }); assert(explicit.sessionFile!.startsWith(explicitDir));
  const env = await spawn({ persistSession: true }); assert(env.sessionFile!.startsWith(envDir));
  const privateAgent = await spawn({}); assert(privateAgent.sessionFile!.startsWith(join(data, "sessions")));
  const memory = await spawn({ persistSession: false, projectDir: "other-project" }); assert.equal(memory.sessionFile, undefined); assert.equal(memory.projectDir, join(project, "other-project"));
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  const projectSetting = await spawn({ persistSession: true }); assert(projectSetting.sessionFile!.startsWith(projectDir));
  writeFileSync(join(project, ".pi", "settings.json"), "{}");
  const globalSetting = await spawn({ persistSession: true }); assert(globalSetting.sessionFile!.startsWith(globalDir));
  writeFileSync(join(config, "settings.json"), "{}");
  const sdkDefault = await spawn({ persistSession: true }); assert(sdkDefault.sessionFile!.startsWith(join(config, "sessions")));
 } finally {
  await manager.close();
  if (oldConfig === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldConfig;
  if (oldSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = oldSessionDir;
 }
});
