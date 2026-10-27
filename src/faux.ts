// Offline demo provider: scripted model that runs one `ls` tool call, then answers.
// Lets the whole Codex -> MCP -> Pi -> panel path run without any API key.
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const step: FauxResponseFactory = (context) => {
	const last = context.messages.at(-1);
	const firstUser = context.messages.find((m) => m.role === "user");
	if (JSON.stringify(firstUser?.content ?? "").includes("SIMULATE_ERROR"))
		return fauxAssistantMessage([], { stopReason: "error", errorMessage: "simulated provider error" });
	if (last?.role === "toolResult") {
		const out = last.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
		return fauxAssistantMessage(fauxText(`[faux model] I read README.md:\n${out.slice(0, 500)}`));
	}
	return fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" });
};

export function installFaux(runtime: ModelRuntime) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-2" }], tokensPerSecond: 40 });
	runtime.registerNativeProvider(faux.provider);
	// Each prompt consumes two model calls; factories inspect context so concurrent agents can't mix answers.
	return { feed: () => faux.appendResponses([step, step]) };
}
