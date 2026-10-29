import { Agent, fetch as undiciFetch } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { pathToFileURL, fileURLToPath } from "node:url";
import { openSync, closeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// 本地服务直连，避免宿主的全局代理接管回环地址。
const localAgent = new Agent();
const localFetch = (url, options) => undiciFetch(url, { ...options, dispatcher: localAgent });
const endpoint = () => `http://127.0.0.1:${process.env.PI_SUBAGENTS_PORT ?? "7788"}`;
const text = { type: "string" };
const specs = [
  ["pi_list_models", "List available Pi models.", { include_faux: { type: "boolean" } }],
  ["pi_spawn_agent", "Start a Pi subagent with a self-contained task. Use pi_wait to collect its result.", { task: text, model: text, thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] }, cwd: text, name: text, tools: { type: "string", enum: ["coding", "read-only"] } }, ["task"]],
  ["pi_wait", "Wait for subagents to finish.", { ids: { type: "array", items: text }, mode: { type: "string", enum: ["any", "all"] }, timeout_sec: { type: "number", minimum: 1, maximum: 240 } }],
  ["pi_get_agent", "Get a subagent result and recent log.", { id: text, log_lines: { type: "number", minimum: 0, maximum: 200 } }, ["id"]],
  ["pi_send_followup", "Send a follow-up to a subagent.", { id: text, message: text }, ["id", "message"]],
  ["pi_abort", "Stop a running subagent.", { id: text }, ["id"]],
  ["pi_list_agents", "List this session's subagents.", {}],
];

async function connect(signal) {
  const client = new Client({ name: "pi-subagents-extension", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${endpoint()}/mcp`), { fetch: localFetch }), { timeout: 3000, signal });
    if (client.getServerVersion()?.name !== "pi-subagents") throw new Error(`Port at ${endpoint()} is occupied by another service`);
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

// 只有连接被拒绝时才启动服务，已有服务必须先通过 MCP 身份检查。
async function ensureService(signal) {
  const deadline = AbortSignal.timeout(12000);
  const limited = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try { return await connect(limited); } catch (error) {
    limited.throwIfAborted();
    try {
      const response = await localFetch(endpoint(), { signal: AbortSignal.any([limited, AbortSignal.timeout(1500)]) });
      if (response.status === 503 && await response.text() === "service starting") return waitForService(undefined, undefined, limited);
    }
    catch (probe) {
      limited.throwIfAborted();
      if (probe?.cause?.code === "ECONNREFUSED") return startService(limited);
      throw new Error(`Cannot inspect ${endpoint()}: ${probe.message}`);
    }
    throw new Error(`Cannot connect to pi-subagents at ${endpoint()}: ${error.message}`);
  }
}

// 从 Pi 宿主包取得 SDK 入口，供后台服务使用同一套依赖。
function hostSdkEntry() {
  const packageDir = getPackageDir();
  try {
    const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const entry = metadata.exports?.["."]?.import;
    if (metadata.name !== "@earendil-works/pi-coding-agent" || typeof entry !== "string" || !entry) throw new Error("invalid SDK entry");
    return pathToFileURL(join(packageDir, entry)).href;
  } catch {
    throw new Error(`Cannot resolve Pi SDK entry from host installation at ${packageDir}. Check your Pi installation.`);
  }
}

async function startService(signal) {
  const log = join(tmpdir(), `pi-subagents-${randomUUID()}.log`);
  const fd = openSync(log, "w", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("./server.js", import.meta.url))], { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, PI_SUBAGENTS_CHILD: "1", PI_SUBAGENTS_SDK_URL: hostSdkEntry() } });
  } finally { closeSync(fd); }
  let failure;
  child.on("error", (error) => { failure = error.message; });
  child.on("exit", (code, signal) => { failure = `process exited (${signal ?? code})`; });
  child.unref();
  try { return await waitForService(log, () => failure, signal); }
  catch (error) {
    if (signal.aborted && signal.reason?.name === "TimeoutError") {
      throw new Error(`Could not start pi-subagents at ${endpoint()}: ${readFileSync(log, "utf8").trim() || failure || "startup timed out"}`);
    }
    throw error;
  }
}

async function waitForService(log, failure, signal) {
  let error;
  for (let i = 0; i < 100; i++) {
    await delay(100, undefined, { signal });
    try { return await connect(signal); } catch (caught) { signal.throwIfAborted(); error = caught; }
  }
  throw new Error(`Could not start pi-subagents at ${endpoint()}: ${(log && readFileSync(log, "utf8").trim()) || failure?.() || error?.message}`);
}

export default function extension(pi) {
  if (process.env.PI_SUBAGENTS_CHILD === "1") return;
  for (const [name, description, properties, required] of specs) {
    pi.registerTool({
      name, label: name, description,
      parameters: { type: "object", properties, ...(required ? { required } : {}), additionalProperties: false },
      async execute(_id, args, signal, _update, ctx) {
        const client = await ensureService(signal);
        try {
          const input = name === "pi_spawn_agent" ? { ...args, cwd: args.cwd ?? ctx.cwd } : args;
          const result = await client.callTool({ name, arguments: input, _meta: { threadId: `pi:${ctx.sessionManager.getSessionId()}` } }, undefined, { signal, timeout: name === "pi_wait" ? 250000 : 60000 });
          if (result.isError) throw new Error(result.content.map((item) => item.text ?? "Tool error").join("\n"));
          return { content: result.content, details: {} };
        } finally { await client.close(); }
      },
    });
  }
}
