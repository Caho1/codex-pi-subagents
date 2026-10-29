import { EventEmitter } from "node:events";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { openPiRuntime } from "./pi-runtime.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type Status = "running" | "idle" | "error" | "aborted";
export type ToolPreset = "coding" | "read-only";

export interface AgentInfo {
	id: string;
	name: string;
	task: string;
	/** Codex conversation that owns this agent. Absent on legacy panel-only records. */
	codexThreadId?: string;
	/** Most recently accepted task or follow-up, whether or not it has completed. */
	lastTask?: string;
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

interface Live { info: AgentInfo; session?: AgentSession; runtime?: AgentSessionRuntime; opening?: Promise<void>; shutdown?: Promise<void>; log: LogLine[]; draft: string; lastError?: string; earlierTurnError?: string; settledAborted?: boolean; pending?: Set<Promise<void>>; preflightTail?: Promise<void>; activeSubmission?: Promise<void>; stopping?: Promise<void>; abortOnStart?: Promise<void>; revision: number }

const MAX_LOG = 500;

export class AgentManager extends EventEmitter {
	private agents = new Map<string, Live>();
	private indexFile: string;
	private preferredModel?: string;
	private setups = new Set<Promise<AgentInfo>>();
	private closing?: Promise<void>;

	constructor(
		private runtime: ModelRuntime,
		private dataDir: string,
		private onPrompt: () => void = () => {},
		private showFaux = false,
	) {
		super();
		mkdirSync(join(dataDir, "sessions"), { recursive: true });
		this.indexFile = join(dataDir, "agents.json");
		this.restore();
		try {
			const saved = readFileSync(join(dataDir, "preferred-model"), "utf8").trim();
			if (saved) this.preferredModel = saved;
		} catch {}
	}

	async listModels(includeFaux = false) {
		const models = await this.runtime.getAvailable();
		return models
			.filter((m) => (includeFaux && this.showFaux) || m.provider !== "faux")
			.map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name, reasoning: m.reasoning, contextWindow: m.contextWindow }));
	}

	/** 面板选择的默认模型：spawn 未指定 model 时优先于 available[0]。 */
	getPreferredModel() { return this.preferredModel ?? null; }

	async setPreferredModel(spec: string | null) {
		if (spec) await this.resolveModel(spec); // 先校验存在，再落盘
		this.preferredModel = spec ?? undefined;
		writeFileSync(join(this.dataDir, "preferred-model"), spec ?? "");
		return this.getPreferredModel();
	}

	list(): AgentInfo[] {
		return [...this.agents.values()].map((a) => a.info).sort((a, b) => b.createdAt - a.createdAt);
	}

	get(id: string) {
		const a = this.agents.get(id);
		if (!a) throw new Error(`unknown agent ${id}`);
		return a;
	}

	async spawn(opts: { task: string; codexThreadId?: string; model?: string; thinking?: ThinkingLevel; cwd?: string; name?: string; tools?: ToolPreset }) {
		if (this.closing) throw new Error("manager is closing");
		const setup = this.spawnInternal(opts);
		this.setups.add(setup);
		try { return await setup; } finally { this.setups.delete(setup); }
	}

	private async spawnInternal(opts: { task: string; codexThreadId?: string; model?: string; thinking?: ThinkingLevel; cwd?: string; name?: string; tools?: ToolPreset }) {
		const model = await this.resolveModel(opts.model);
		const id = randomUUID().slice(0, 8);
		const cwd = opts.cwd ?? process.cwd();
		const info: AgentInfo = {
			id,
			name: opts.name ?? `pi-${id}`,
			task: opts.task,
			codexThreadId: opts.codexThreadId,
			lastTask: opts.task,
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
		const live: Live = { info, log: [], draft: "", revision: 0 };
		const runtime = await openPiRuntime({
			cwd, model, modelRuntime: this.runtime, thinking: info.thinking, preset: info.tools,
			sessionManager: SessionManager.create(cwd, join(this.dataDir, "sessions")),
		});
		live.runtime = runtime;
		const session = runtime.session;
		this.agents.set(id, live); // only after creation succeeded: no phantom "running" agents
		this.attach(live, session);
		this.run(live, opts.task);
		return info;
	}

	async followup(id: string, message: string) {
		if (this.closing) throw new Error("manager is closing");
		const live = this.get(id);
		if (live.stopping) throw new Error("agent is stopping; retry after it stops");
		if (live.shutdown) await live.shutdown;
		if (this.closing) throw new Error("manager is closing");
		if (!live.session) await (live.opening ??= this.reopen(live).finally(() => (live.opening = undefined)));
		if (this.closing) throw new Error("manager is closing");
		if (live.stopping) throw new Error("agent is stopping; retry after it stops");
		this.run(live, message);
		return live.info;
	}

	async abort(id: string) {
		const live = this.get(id);
		if (live.stopping) { await live.stopping; return live.info; }
		if (live.info.status !== "running") return live.info;
		const session = live.session!;
		// 输入预处理可能在首次 abort 后才启动，因此等待已提交输入后再确认停止。
		live.stopping = (async () => {
			session.clearQueue();
			await session.abort();
			await Promise.allSettled([...live.pending ?? []]);
			await live.abortOnStart;
			session.clearQueue();
			await session.abort();
			await session.waitForIdle();
			const shutdown = this.shutdownRuntime(live, session);
			this.update(live, { status: "aborted" });
			await shutdown;
		})();
		try { await live.stopping; } catch (err) {
			live.lastError = String((err as Error)?.message ?? err);
			if (!session.isStreaming && !live.pending?.size) this.update(live, { status: "error", error: live.lastError });
			throw err;
		} finally { live.stopping = undefined; live.abortOnStart = undefined; }
		return live.info;
	}

	/** Resolve when the given agents (or all running ones) leave `running`, or on timeout. */
	async wait(ids: string[] | undefined, mode: "any" | "all", timeoutMs: number, signal?: AbortSignal) {
		const targets = ids?.length ? ids.map((id) => this.get(id).info.id) : this.list().filter((a) => a.status === "running").map((a) => a.id);
		const done = () => {
			const finished = targets.filter((id) => this.get(id).info.status !== "running");
			return mode === "any" ? finished.length > 0 || targets.length === 0 : finished.length === targets.length;
		};
		if (signal?.aborted) throw signal.reason ?? new Error("wait cancelled");
		if (!done()) {
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => { clearTimeout(timer); this.off("agent", onChange); signal?.removeEventListener("abort", onAbort); };
				const finish = () => { cleanup(); resolve(); };
				const onChange = () => { if (done()) finish(); };
				const onAbort = () => { cleanup(); reject(signal?.reason ?? new Error("wait cancelled")); };
				const timer = setTimeout(finish, timeoutMs);
				this.on("agent", onChange);
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) onAbort(); else onChange();
			});
		}
		return { timedOut: !done(), agents: targets.map((id) => this.get(id).info) };
	}

	logOf(id: string) { return this.get(id).log; }
	detail(id: string) { const a = this.get(id); return { ...a.info, log: [...a.log], draft: a.draft, revision: a.revision }; }

	private run(live: Live, text: string) {
		if (live.info.status !== "running") {
			live.settledAborted = false;
			live.lastError = undefined;
			live.earlierTurnError = undefined;
		}
		this.push(live, "user", text);
		this.update(live, { status: "running", lastTask: text, error: undefined, result: undefined });
		const pending = live.pending ??= new Set();
		// Pi input handlers run before the session becomes busy. Serialize just this
		// preflight so later inputs can still enter Pi's native follow-up queue.
		const previous = live.preflightTail ?? Promise.resolve();
		let releasePreflight!: () => void;
		const preflight = new Promise<void>((resolve) => { releasePreflight = resolve; });
		live.preflightTail = preflight;
		const submission = previous.then(async () => {
			// A run can be settling after isStreaming becomes false. Let it finish
			// before starting another prompt instead of dispatching into that gap.
			const active = live.activeSubmission;
			if (!live.session!.isStreaming && active) await active.catch(() => {});
			if (live.stopping) return; // abort also discards inputs waiting in this queue
			this.onPrompt();
			const prompt = live.session!.prompt(text, {
				streamingBehavior: "followUp",
				preflightResult: (disposition) => {
					if (disposition === "started") live.activeSubmission = submission;
					releasePreflight();
				},
			});
			await Promise.all([prompt, preflight]);
		}).finally(releasePreflight);
		pending.add(submission);
		void submission.catch((err: unknown) => { live.lastError = String((err as Error)?.message ?? err); })
			.finally(() => {
				pending.delete(submission);
				if (live.preflightTail === preflight) live.preflightTail = undefined;
				if (live.activeSubmission === submission) live.activeSubmission = undefined;
				void this.settle(live);
			});
	}

	private async settle(live: Live) {
		const session = live.session;
		if (!session) return;
		await session.waitForIdle();
		if (live.session !== session || live.stopping || live.pending?.size || live.info.status !== "running") return;
		const result = session.getLastAssistantText();
		this.shutdownRuntime(live, session);
		if (live.settledAborted) this.update(live, { status: "aborted" });
		else if (live.earlierTurnError || live.lastError) this.update(live, { status: "error", error: live.earlierTurnError ?? live.lastError });
		else this.update(live, { status: "idle", result });
	}

	/** 在广播结束状态前登记关闭操作，追问必须等待旧扩展退出。 */
	private shutdownRuntime(live: Live, session: AgentSession): Promise<void> {
		if (live.shutdown) return live.shutdown;
		const runtime = live.runtime;
		if (!runtime || live.session !== session) return Promise.resolve();
		const shutdown = Promise.resolve().then(async () => {
			await runtime.dispose();
			const file = live.info.sessionFile;
			if (file && !existsSync(file)) {
				const temp = `${file}.${randomUUID()}.tmp`;
				try {
					session.exportToJsonl(temp);
					try { linkSync(temp, file); }
					catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
				} finally { if (existsSync(temp)) unlinkSync(temp); }
			}
			if (live.runtime === runtime && live.session === session) {
				live.runtime = undefined;
				live.session = undefined;
			}
			if (live.shutdown === shutdown) live.shutdown = undefined;
		}).catch((err: unknown) => {
			const error = `agent runtime shutdown failed: ${String(err)}`;
			this.update(live, { status: "error", error });
			throw new Error(error, { cause: err });
		});
		live.shutdown = shutdown;
		void shutdown.catch(() => {});
		return shutdown;
	}

	private attach(live: Live, session: AgentSession) {
		live.session = session;
		live.info.sessionFile = session.sessionFile;
		session.subscribe((e) => this.onEvent(live, e));
	}

	private onEvent(live: Live, e: AgentSessionEvent) {
		switch (e.type) {
			case "agent_start":
				live.settledAborted = false;
				if (live.stopping) {
					live.abortOnStart = live.session!.abort();
					void live.abortOnStart.catch(() => {});
				}
				break;
			case "message_start":
				// A new user turn after a model error means the failed turn was not
				// recovered by Pi's retry; later follow-up success must not hide it.
				if (e.message.role === "user" && live.lastError) live.earlierTurnError ??= live.lastError;
				break;
			case "message_update":
				if (e.assistantMessageEvent.type === "text_delta") {
					live.draft += e.assistantMessageEvent.delta;
					this.emit("delta", { id: live.info.id, delta: e.assistantMessageEvent.delta, revision: ++live.revision });
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
				live.settledAborted = e.aborted;
				void this.settle(live);
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
		this.emit("log", { id: live.info.id, line, revision: ++live.revision });
	}

	private update(live: Live, patch: Partial<AgentInfo>) {
		Object.assign(live.info, patch, { updatedAt: Date.now() });
		this.save();
		this.emit("agent", live.info);
	}

	private async resolveModel(spec?: string): Promise<Model<Api>> {
		const available = await this.runtime.getAvailable();
		if (!spec) {
			if (this.preferredModel) return this.resolveModel(this.preferredModel);
			if (!available[0]) throw new Error("no model with credentials; configure a Pi provider (pi /login or API key env)");
			return available[0];
		}
		const exact = available.find((m) => `${m.provider}/${m.id}` === spec);
		const matches = available.filter((m) => m.id === spec);
		if (!exact && matches.length > 1) throw new Error(`ambiguous model: ${spec}. Use provider/model.`);
		const model = exact ?? matches[0];
		if (!model) throw new Error(`model not found: ${spec}. Use pi_list_models.`);
		return model;
	}

	private async reopen(live: Live) {
		if (!live.info.sessionFile || !existsSync(live.info.sessionFile)) throw new Error("agent session file is missing");
		const header = JSON.parse(readFileSync(live.info.sessionFile, "utf8").split("\n")[0]);
		if (header.type !== "session") throw new Error("invalid agent session header");
		const model = await this.resolveModel(live.info.model);
		const runtime = await openPiRuntime({
			cwd: live.info.cwd, model, modelRuntime: this.runtime, thinking: live.info.thinking,
			preset: live.info.tools, sessionManager: SessionManager.open(live.info.sessionFile),
		});
		live.runtime = runtime;
		const session = runtime.session;
		this.attach(live, session);
	}

	/** 停止接收新任务并等待已启动的会话完成关闭，重复调用复用同一操作。 */
	close(): Promise<void> {
		return this.closing ??= (async () => {
			await Promise.allSettled([...this.setups]);
			const results = await Promise.allSettled([...this.agents.values()].map(async (live) => {
				await live.opening;
				if (live.info.status === "running") await this.abort(live.info.id);
				await Promise.allSettled([...live.pending ?? []]);
				if (live.shutdown) await live.shutdown;
				else if (live.session) await this.shutdownRuntime(live, live.session);
			}));
			const failed = results.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
		})();
	}

	private save() {
		writeFileSync(`${this.indexFile}.tmp`, JSON.stringify(this.list(), null, 2));
		renameSync(`${this.indexFile}.tmp`, this.indexFile); // atomic: a crash never leaves a torn index
	}

	private restore() {
		let raw: string;
		try { raw = readFileSync(this.indexFile, "utf8"); }
		catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
		let entries: AgentInfo[];
		try {
			entries = JSON.parse(raw);
			if (!Array.isArray(entries) || entries.some((info) => !info || typeof info.id !== "string" || !["running", "idle", "error", "aborted"].includes(info.status))) throw new Error("invalid index entries");
		} catch (err) { throw new Error(`invalid agent index ${this.indexFile}: ${String(err)}`); }
		for (const info of entries) {
			if (info.status === "running") { info.status = "aborted"; info.error = "进程中断，请发送后续指令继续"; }
			let log: LogLine[] = [];
			try { if (info.sessionFile) log = logFromSession(info.sessionFile); }
			catch (err) { info.status = "error"; info.error = `会话恢复失败: ${String(err)}`; }
			this.agents.set(info.id, { info, log, draft: "", revision: 0 });
		}
	}
}

/** Rebuild panel log lines from a persisted Pi session JSONL (so history survives restarts). */
function logFromSession(file: string): LogLine[] {
	const log: LogLine[] = [];
	if (!existsSync(file)) throw new Error(`session file is missing: ${file}`);
	const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
	if (header.type !== "session") throw new Error(`invalid session header: ${file}`);
	for (const e of SessionManager.open(file).getEntries()) {
		if (e.type !== "message") continue;
		const t = Date.parse(e.timestamp) || 0;
		if (e.message.role !== "user" && e.message.role !== "assistant") continue;
		const blocks = Array.isArray(e.message.content) ? e.message.content : [];
		const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
		if (e.message.role === "user" && text) log.push({ t, kind: "user", text });
		if (e.message.role === "assistant") {
			if (text) log.push({ t, kind: "assistant", text });
			for (const b of blocks) if (b.type === "toolCall") log.push({ t, kind: "tool", text: `${b.name} ${JSON.stringify(b.arguments).slice(0, 300)}` });
			if (e.message.errorMessage) log.push({ t, kind: "error", text: e.message.errorMessage });
		}
	}
	return log.slice(-MAX_LOG);
}
