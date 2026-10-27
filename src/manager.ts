import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	type ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type Status = "running" | "idle" | "error" | "aborted";
export type ToolPreset = "coding" | "read-only";

export interface AgentInfo {
	id: string;
	name: string;
	task: string;
	model: string;
	thinking: ThinkingLevel;
	cwd: string;
	tools: ToolPreset;
	status: Status;
	createdAt: number;
	updatedAt: number;
	turns: number;
	tokens: { input: number; output: number };
	cost: number;
	result?: string;
	error?: string;
	sessionFile?: string;
}

export interface LogLine { t: number; kind: string; text: string }

interface Live { info: AgentInfo; session?: AgentSession; opening?: Promise<void>; log: LogLine[]; draft: string; lastError?: string }

const READ_ONLY = ["read", "grep", "find", "ls"];
const MAX_LOG = 500;

export class AgentManager extends EventEmitter {
	private agents = new Map<string, Live>();
	private indexFile: string;

	constructor(
		private runtime: ModelRuntime,
		private dataDir: string,
		private onPrompt: () => void = () => {},
	) {
		super();
		mkdirSync(join(dataDir, "sessions"), { recursive: true });
		this.indexFile = join(dataDir, "agents.json");
		this.restore();
	}

	async listModels() {
		const models = await this.runtime.getAvailable();
		return models.map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name, reasoning: m.reasoning, contextWindow: m.contextWindow }));
	}

	list(): AgentInfo[] {
		return [...this.agents.values()].map((a) => a.info).sort((a, b) => b.createdAt - a.createdAt);
	}

	get(id: string) {
		const a = this.agents.get(id);
		if (!a) throw new Error(`unknown agent ${id}`);
		return a;
	}

	async spawn(opts: { task: string; model?: string; thinking?: ThinkingLevel; cwd?: string; name?: string; tools?: ToolPreset }) {
		const model = await this.resolveModel(opts.model);
		const id = randomUUID().slice(0, 8);
		const cwd = opts.cwd ?? process.cwd();
		const info: AgentInfo = {
			id,
			name: opts.name ?? `pi-${id}`,
			task: opts.task,
			model: `${model.provider}/${model.id}`,
			thinking: opts.thinking ?? "medium",
			cwd,
			tools: opts.tools ?? "coding",
			status: "running",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			turns: 0,
			tokens: { input: 0, output: 0 },
			cost: 0,
		};
		const live: Live = { info, log: [], draft: "" };
		const { session } = await createAgentSession({
			cwd,
			model,
			modelRuntime: this.runtime,
			thinkingLevel: info.thinking,
			sessionManager: SessionManager.create(cwd, join(this.dataDir, "sessions")),
			tools: info.tools === "read-only" ? READ_ONLY : undefined,
		});
		this.agents.set(id, live); // only after creation succeeded: no phantom "running" agents
		this.attach(live, session);
		this.run(live, opts.task);
		return info;
	}

	async followup(id: string, message: string) {
		const live = this.get(id);
		if (!live.session) await (live.opening ??= this.reopen(live).finally(() => (live.opening = undefined)));
		const session = live.session!;
		if (live.info.status === "running") {
			await session.followUp(message);
			this.push(live, "user", `(queued follow-up) ${message}`);
		} else {
			this.run(live, message);
		}
		return live.info;
	}

	async abort(id: string) {
		const live = this.get(id);
		if (live.info.status !== "running") return live.info;
		live.session?.clearQueue();
		this.update(live, { status: "aborted" });
		await live.session?.abort();
		return live.info;
	}

	/** Resolve when the given agents (or all running ones) leave `running`, or on timeout. */
	async wait(ids: string[] | undefined, mode: "any" | "all", timeoutMs: number) {
		const targets = ids?.length ? ids.map((id) => this.get(id).info.id) : this.list().filter((a) => a.status === "running").map((a) => a.id);
		const done = () => {
			const finished = targets.filter((id) => this.get(id).info.status !== "running");
			return mode === "any" ? finished.length > 0 || targets.length === 0 : finished.length === targets.length;
		};
		if (!done()) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(finish, timeoutMs);
				const onChange = () => done() && finish();
				function finish() { clearTimeout(timer); self.off("agent", onChange); resolve(); }
				const self = this;
				this.on("agent", onChange);
			});
		}
		return { timedOut: !done(), agents: targets.map((id) => this.get(id).info) };
	}

	logOf(id: string) { return this.get(id).log; }

	private run(live: Live, text: string) {
		this.onPrompt();
		this.push(live, "user", text);
		live.lastError = undefined;
		this.update(live, { status: "running", error: undefined, result: undefined });
		// Completion is decided by `agent_settled` (Pi may queue/retry after prompt() resolves); only rejections land here.
		live.session!.prompt(text).catch((err: unknown) => this.update(live, { status: "error", error: String((err as Error)?.message ?? err) }));
	}

	private attach(live: Live, session: AgentSession) {
		live.session = session;
		live.info.sessionFile = session.sessionFile;
		session.subscribe((e) => this.onEvent(live, e));
	}

	private onEvent(live: Live, e: AgentSessionEvent) {
		switch (e.type) {
			case "message_update":
				if (e.assistantMessageEvent.type === "text_delta") {
					live.draft += e.assistantMessageEvent.delta;
					this.emit("delta", { id: live.info.id, delta: e.assistantMessageEvent.delta });
				}
				break;
			case "message_end": {
				const m = e.message;
				if (m.role !== "assistant") break;
				live.draft = "";
				const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
				if (text) this.push(live, "assistant", text);
				if (m.stopReason === "error") this.push(live, "error", (live.lastError = m.errorMessage ?? "model error"));
				else live.lastError = undefined; // a later successful turn (e.g. retry) clears it
				const u = m.usage;
				live.info.tokens.input += u.input;
				live.info.tokens.output += u.output;
				live.info.cost += u.cost.total;
				live.info.turns += 1;
				this.update(live, {});
				break;
			}
			case "agent_settled":
				if (live.info.status !== "running") break;
				if (e.aborted) this.update(live, { status: "aborted" });
				else if (live.lastError) this.update(live, { status: "error", error: live.lastError });
				else this.update(live, { status: "idle", result: live.session!.getLastAssistantText() });
				break;
			case "tool_execution_start":
				this.push(live, "tool", `${e.toolName} ${JSON.stringify(e.args).slice(0, 300)}`);
				break;
			case "tool_execution_end":
				if (e.isError) this.push(live, "tool-error", `${e.toolName} failed`);
				break;
		}
	}

	private push(live: Live, kind: string, text: string) {
		const line = { t: Date.now(), kind, text };
		live.log.push(line);
		if (live.log.length > MAX_LOG) live.log.shift();
		this.emit("log", { id: live.info.id, line });
	}

	private update(live: Live, patch: Partial<AgentInfo>) {
		Object.assign(live.info, patch, { updatedAt: Date.now() });
		this.emit("agent", live.info);
		this.save();
	}

	private async resolveModel(spec?: string) {
		const available = await this.runtime.getAvailable();
		if (!spec) {
			if (!available[0]) throw new Error("no model with credentials; configure a Pi provider (pi /login or API key env)");
			return available[0];
		}
		const [provider, ...rest] = spec.split("/");
		const model = rest.length ? this.runtime.getModel(provider, rest.join("/")) : available.find((m) => m.id === spec);
		if (!model) throw new Error(`model not found: ${spec}. Use pi_list_models.`);
		return model;
	}

	private async reopen(live: Live) {
		if (!live.info.sessionFile) throw new Error("agent has no persisted session");
		const model = await this.resolveModel(live.info.model);
		const { session } = await createAgentSession({
			cwd: live.info.cwd,
			model,
			modelRuntime: this.runtime,
			thinkingLevel: live.info.thinking,
			sessionManager: SessionManager.open(live.info.sessionFile),
			tools: live.info.tools === "read-only" ? READ_ONLY : undefined,
		});
		this.attach(live, session);
	}

	private save() {
		writeFileSync(`${this.indexFile}.tmp`, JSON.stringify(this.list(), null, 2));
		renameSync(`${this.indexFile}.tmp`, this.indexFile); // atomic: a crash never leaves a torn index
	}

	private restore() {
		try {
			for (const info of JSON.parse(readFileSync(this.indexFile, "utf8")) as AgentInfo[]) {
				if (info.status === "running") info.status = "aborted"; // process died mid-run
				this.agents.set(info.id, { info, log: info.sessionFile ? logFromSession(info.sessionFile) : [], draft: "" });
			}
		} catch {}
	}
}

/** Rebuild panel log lines from a persisted Pi session JSONL (so history survives restarts). */
function logFromSession(file: string): LogLine[] {
	const log: LogLine[] = [];
	try {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			const e = JSON.parse(line);
			if (e.type !== "message") continue;
			const t = Date.parse(e.timestamp) || 0;
			const blocks: { type: string; text?: string; name?: string; arguments?: unknown }[] = Array.isArray(e.message?.content) ? e.message.content : [];
			const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
			if (e.message.role === "user" && text) log.push({ t, kind: "user", text });
			if (e.message.role === "assistant") {
				if (text) log.push({ t, kind: "assistant", text });
				for (const b of blocks) if (b.type === "toolCall") log.push({ t, kind: "tool", text: `${b.name} ${JSON.stringify(b.arguments).slice(0, 300)}` });
				if (e.message.errorMessage) log.push({ t, kind: "error", text: e.message.errorMessage });
			}
		}
	} catch {}
	return log.slice(-MAX_LOG);
}
