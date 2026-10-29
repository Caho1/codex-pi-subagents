import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
	createCodemodeExtension, createMcpExtension, createToolSearchExtension,
	getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore, SettingsManager,
	type AgentSessionRuntime, type ModelRuntime, type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ToolPreset } from "./manager.ts";

/** 每个代理独立持有扩展和 MCP 生命周期，恢复会话也使用相同的初始化流程。 */
export async function openPiRuntime(options: {
	cwd: string; model: Model<Api>; thinking: ThinkingLevel; preset: ToolPreset;
	modelRuntime: ModelRuntime; sessionManager: SessionManager;
}): Promise<AgentSessionRuntime> {
	const agentDir = getAgentDir();
	const factory = async ({ cwd, sessionManager }: { cwd: string; sessionManager: SessionManager; agentDir: string }) => {
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const trust = new ProjectTrustStore(agentDir);
		const services = await createAgentSessionServices({
			cwd, agentDir, settingsManager: settings, modelRuntime: options.modelRuntime,
			resourceLoaderOptions: options.preset === "read-only" ? { noExtensions: true } : {
				extensionFactories: [
					{ name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
					{ name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
					{ name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
				],
			},
			resourceLoaderReloadOptions: { resolveProjectTrust: async ({ extensionsResult }) => {
				if (!hasTrustRequiringProjectResources(cwd)) return true;
				// 全局扩展先于已保存的信任决定，项目扩展无法参与自身授权。
				const handlers = extensionsResult.extensions.flatMap((extension) =>
					[...(extension.handlers.get("project_trust") ?? [])].map((handler) => ({ handler, path: extension.path })));
				const context = { cwd, mode: "rpc", hasUI: false, ui: {
					select: async () => undefined, confirm: async () => false, input: async () => undefined,
					notify: (message: string) => console.error("[pi-subagents]", message),
				} };
				for (const { handler, path } of handlers) {
					let result: unknown;
					try { result = await handler({ type: "project_trust", cwd }, context); }
					catch (error) { console.error(`[pi-subagents] extension ${path} project_trust`, error); continue; }
					if (result === null || result === undefined) continue;
					const decision = typeof result === "object" ? result : {};
					if ("trusted" in decision && decision.trusted === "undecided") continue;
					const trusted = "trusted" in decision && decision.trusted === "yes";
					// 保存失败必须中止启动，不能用旧决定覆盖扩展的拒绝。
					if ("remember" in decision && decision.remember === true) trust.set(cwd, trusted);
					return trusted;
				}
				return trust.get(cwd) ?? settings.getDefaultProjectTrust() === "always";
			} },
		});
		for (const diagnostic of services.diagnostics) console.error("[pi-subagents]", diagnostic.message);
		const extensions = services.resourceLoader.getExtensions();
		for (const error of extensions.errors) console.error(`[pi-subagents] extension ${error.path}: ${error.error}`);
		for (const warning of extensions.warnings ?? []) console.error(`[pi-subagents] extension ${warning.path}: ${warning.warning}`);
		const result = await createAgentSessionFromServices({
			services, sessionManager, model: options.model, thinkingLevel: options.thinking,
			...(options.preset === "read-only" ? { tools: ["read", "grep", "find", "ls"], excludeTools: ["mcp__*"] } : {}),
		});
		return { ...result, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(factory, { cwd: options.cwd, agentDir, sessionManager: options.sessionManager });
	try {
		await runtime.session.bindExtensions({ mode: "rpc", onError: (error) => console.error("[pi-subagents] extension", error) });
		return runtime;
	} catch (error) {
		await runtime.dispose();
		throw error;
	}
}
