import { EventEmitter } from "node:events";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { AgentTranscript } from "./transcript.ts";
import { randomUUID } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionRuntime,
	type ModelRuntime,
	SessionManager, SettingsManager, getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { openPiRuntime } from "./pi-runtime.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type Status = "running" | "idle" | "error" | "aborted";
export type ToolPreset = "coding" | "read-only";

type NativeSessionPolicy = { mode: "private" } | { mode: "memory" } | { mode: "pi"; directory?: string };
type SpawnOptions = { task: string; codexThreadId?: string; model?: string; thinking?: ThinkingLevel; cwd?: string; name?: string; tools?: ToolPreset; persistSession?: boolean; sessionDir?: string; projectDir?: string };

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
	projectDir?: string;
	transcriptFile?: string;
	transcriptError?: string;
	nativeSession?: NativeSessionPolicy;
}

export interface LogLine { t: number; kind: string; text: string }

interface Live { info: AgentInfo; transcript?: AgentTranscript; transcriptFailed?: boolean; transcriptFailureMessage?: string; transcriptUnsubscribe?: () => void; unsubscribe?: () => void; memorySession?: SessionManager; session?: AgentSession; runtime?: AgentSessionRuntime; opening?: Promise<void>; shutdown?: Promise<void>; log: LogLine[]; draft: string; lastError?: string; earlierTurnError?: string; settledAborted?: boolean; pending?: Set<Promise<void>>; preflightTail?: Promise<void>; activeSubmission?: Promise<void>; stopping?: Promise<void>; abortOnStart?: Promise<void>; revision: number }

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

	async spawn(opts: SpawnOptions) {
		if (this.closing) throw new Error("manager is closing");
		const setup = this.spawnInternal(opts);
		this.setups.add(setup);
		try { return await setup; } finally { this.setups.delete(setup); }
	}

	private async spawnInternal(opts: SpawnOptions) {
		if (opts.persistSession !== undefined && typeof opts.persistSession !== "boolean") throw new Error("persist_session must be a boolean");
		if (opts.sessionDir !== undefined && typeof opts.sessionDir !== "string") throw new Error("session_dir must be a string");
		if (opts.projectDir !== undefined && (typeof opts.projectDir !== "string" || !opts.projectDir.trim())) throw new Error("project_dir must be a non-empty string");
		if (opts.sessionDir !== undefined && opts.persistSession !== true) throw new Error("session_dir requires persist_session=true");
		if (opts.sessionDir !== undefined && !opts.sessionDir.trim()) throw new Error("session_dir must not be empty");
		const model = await this.resolveModel(opts.model);
		const id = randomUUID().slice(0, 8);
		const cwd = resolve(opts.cwd ?? process.cwd());
		const projectDir = resolve(cwd, opts.projectDir ?? cwd);
		const directory = opts.sessionDir === undefined ? undefined : resolve(cwd, opts.sessionDir === "~" ? homedir() : opts.sessionDir.startsWith("~/") ? join(homedir(), opts.sessionDir.slice(2)) : opts.sessionDir);
		const configuredDirectory = opts.persistSession === true && directory === undefined
			? process.env.PI_CODING_AGENT_SESSION_DIR || SettingsManager.create(cwd, getAgentDir()).getSessionDir()
			: undefined;
		const selectedDirectory = directory ?? (configuredDirectory ? resolve(cwd, configuredDirectory === "~" ? homedir() : configuredDirectory.startsWith("~/") ? join(homedir(), configuredDirectory.slice(2)) : configuredDirectory) : undefined);
		const policy: NativeSessionPolicy = opts.persistSession === undefined ? { mode: "private" } : opts.persistSession ? { mode: "pi", directory: selectedDirectory } : { mode: "memory" };
		const info: AgentInfo = {
			id,
			name: opts.name ?? `pi-${id}`,
			task: opts.task,
			codexThreadId: opts.codexThreadId,
			lastTask: opts.task,
			model: `${model.provider}/${model.id}`,
			thinking: opts.thinking ?? "medium",
			cwd, projectDir, nativeSession: policy,
			tools: opts.tools ?? "coding",
			status: "running",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			turns: 0,
			tokens: { input: 0, output: 0 },
			cost: 0,
		};
		const live: Live = { info, log: [], draft: "", revision: 0 };
		live.transcript = AgentTranscript.create(projectDir, id, cwd);
		info.transcriptFile = live.transcript.file;
		try {
			const sessionManager = policy.mode === "memory" ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, policy.mode === "private" ? join(this.dataDir, "sessions") : policy.directory);
			if (policy.mode === "memory") live.memorySession = sessionManager;
			live.runtime = await openPiRuntime({ cwd, model, modelRuntime: this.runtime, thinking: info.thinking, preset: info.tools,
				sessionManager, onSession: (session) => this.attachTranscript(live, session) });
			if (info.transcriptError) { await live.runtime.dispose(); throw new Error(info.transcriptError); }
		} catch (error) { live.transcriptUnsubscribe?.(); live.transcript.close(); throw error; }
		this.agents.set(id, live);
		this.attach(live, live.runtime.session);
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
					if (disposition === "handled") this.record(live, { role: "handled", text });
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
		if (live.transcriptFailed) this.update(live, { status: "error", error: live.transcriptFailureMessage });
		else if (live.settledAborted) this.update(live, { status: "aborted" });
		else if (live.earlierTurnError || live.lastError) this.update(live, { status: "error", error: live.earlierTurnError ?? live.lastError });
		else this.update(live, { status: "idle", result });
	}

	/** 在广播结束状态前登记关闭操作，追问必须等待旧扩展退出。 */
	private shutdownRuntime(live: Live, session: AgentSession): Promise<void> {
		if (live.shutdown) return live.shutdown;
		const runtime = live.runtime;
		if (!runtime || live.session !== session) return Promise.resolve();
		const shutdown = Promise.resolve().then(async () => {
			try { await runtime.dispose(); } finally {
				live.unsubscribe?.(); live.unsubscribe = undefined;
				live.transcriptUnsubscribe?.(); live.transcriptUnsubscribe = undefined;
				try { live.transcript?.close(); } catch (error) { this.transcriptFailure(live, error); }
				live.transcript = undefined;
			}
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

	private attachTranscript(live: Live, session: AgentSession) {
		live.transcriptUnsubscribe = session.subscribe((event) => {
			if (event.type === "message_end") this.record(live, event.message);
		});
	}

	private attach(live: Live, session: AgentSession) {
		live.session = session;
		live.info.sessionFile = session.sessionFile;
		live.unsubscribe = session.subscribe((e) => this.onEvent(live, e));
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

	// 监听器不能抛错，否则 SDK 后续的原生消息追加会被中断。
	private record<T extends { role: string }>(live: Live, message: T) {
		try { live.transcript?.append(message); } catch (error) { this.transcriptFailure(live, error); }
	}

	private transcriptFailure(live: Live, error: unknown) {
		live.transcriptFailed = true;
		live.transcriptFailureMessage = `transcript write failed: ${String(error)}`;
		live.info.transcriptError ??= live.transcriptFailureMessage;
		try {
			if (this.agents.has(live.info.id)) this.update(live, live.info.status === "running"
				? { transcriptError: live.info.transcriptError }
				: { status: "error", error: live.transcriptFailureMessage, transcriptError: live.info.transcriptError });
		} catch {}
		queueMicrotask(() => { if (live.session?.isStreaming) void live.session.abort().catch(() => {}); });
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
		const info = live.info;
		if (info.nativeSession?.mode === "memory" && !live.memorySession) throw new Error(`内存会话在服务重启后无法恢复上下文，记录位于 ${info.transcriptFile ?? "未知路径"}`);
		if (!live.memorySession && (!info.sessionFile || !existsSync(info.sessionFile))) throw new Error("agent session file is missing");
		if (!info.transcriptFile) {
			try {
				info.projectDir ??= info.cwd;
				info.transcriptFile = AgentTranscript.importLegacy(info.projectDir, info.id, info.cwd, info.sessionFile!);
				this.save();
			} catch (error) { info.error = `transcript import failed: ${String(error)}`; this.save(); throw new Error(info.error); }
		}
		live.transcript = AgentTranscript.open(info.transcriptFile, info.id, info.cwd);
		live.transcriptFailed = false;
		live.transcriptFailureMessage = undefined;
		try {
			const sessionManager = live.memorySession ?? SessionManager.open(info.sessionFile!);
			const model = await this.resolveModel(info.model);
			live.runtime = await openPiRuntime({ cwd: info.cwd, model, modelRuntime: this.runtime, thinking: info.thinking,
				preset: info.tools, sessionManager, onSession: (session) => this.attachTranscript(live, session) });
			if (live.transcriptFailed) { await live.runtime.dispose(); throw new Error(live.transcriptFailureMessage); }
			this.attach(live, live.runtime.session);
		} catch (error) { live.transcriptUnsubscribe?.(); live.transcriptUnsubscribe = undefined; live.unsubscribe?.(); live.unsubscribe = undefined; live.session = undefined; live.transcript.close(); live.transcript = undefined; throw error; }
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
			if (info.transcriptFile) {
				try {
					log = logFromTranscript(info.transcriptFile);
					AgentTranscript.validate(info.transcriptFile, info.id);
				} catch (err) {
					info.transcriptError ??= `transcript invalid: ${String(err)}`;
					info.status = "error";
					info.error = info.transcriptError;
				}
			}
			if (info.nativeSession?.mode !== "memory" && info.sessionFile) {
				try {
					const nativeLog = logFromSession(info.sessionFile);
					if (!info.transcriptFile) log = nativeLog;
				} catch (err) {
					info.status = "error";
					info.error = `会话恢复失败: ${String(err)}`;
				}
			}
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

function logFromTranscript(file: string): LogLine[] {
	type Message = { role: string; text?: string; content?: string | { type: string; text?: string; name?: string; arguments?: unknown }[]; toolName?: string; isError?: boolean; errorMessage?: string };
	const log: LogLine[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		let record: { message: Message; timestamp: string };
		try { record = JSON.parse(line) as typeof record; } catch { break; }
		const m = record.message;
		const t = Date.parse(record.timestamp) || 0;
		if (m.role === "handled") { log.push({ t, kind: "user", text: m.text ?? "" }); continue; }
		if (m.role === "toolResult" && m.isError) { log.push({ t, kind: "tool-error", text: `${m.toolName} failed` }); continue; }
		if (m.role !== "user" && m.role !== "assistant") continue;
		const blocks = Array.isArray(m.content) ? m.content : [];
		const text = typeof m.content === "string" ? m.content : blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
		if (text) log.push({ t, kind: m.role, text });
		if (m.role === "assistant") {
			for (const b of blocks) if (b.type === "toolCall") log.push({ t, kind: "tool", text: `${b.name} ${JSON.stringify(b.arguments ?? {}).slice(0, 300)}` });
			if (m.errorMessage) log.push({ t, kind: "error", text: m.errorMessage });
		}
	}
	return log.slice(-MAX_LOG);
}
