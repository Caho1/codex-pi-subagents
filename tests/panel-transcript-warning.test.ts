import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("selected agent shows escaped transcript failure independently of its status", async () => {
 const html = await readFile(new URL("../src/panel.html", import.meta.url), "utf8");
 const escapeSource = html.slice(html.indexOf("const esc ="), html.indexOf("\nconst paths ="));
 const source = html.slice(html.indexOf("function renderDetail()"), html.indexOf("\n// Codex 用 fade mask"));
 const elements: Record<string, any> = { "title-slot": {}, log: { scrollHeight: 100 } };
 const agent = { id: "a", name: "Agent", model: "model", thinking: "low", status: "idle", transcriptError: "<img src=x onerror='alert(1)'> & failure" };
 const context = {
  agents: new Map([["a", agent]]), sel: "a",
  document: { body: { classList: { toggle() {} } }, querySelector: () => ({ hidden: false }) },
  $: (id: string) => elements[id], icon: () => "", avatar: () => "",
  renderTranscript: () => "<p>现有对话</p>", renderMermaid() {}, markCodeOverflow() {},
 };
 const render = runInNewContext(`${escapeSource}\n${source}\nrenderDetail`, context);
 render();
 assert.match(elements.log.innerHTML, /role="alert"/);
 assert.match(elements.log.innerHTML, /对话记录写入失败，历史可能不完整/);
 assert.match(elements.log.innerHTML, /&lt;img src=x onerror=&#39;alert\(1\)&#39;&gt; &amp; failure/);
 assert.doesNotMatch(elements.log.innerHTML, /<img/);
 assert.match(elements.log.innerHTML, /<p>现有对话<\/p>/);

 agent.transcriptError = "";
 render();
 assert.equal(elements.log.innerHTML, '<div class="transcript"><p>现有对话</p></div>');

 context.sel = "missing";
 render();
 assert.match(elements.log.innerHTML, /选择一个子智能体/);
 assert.doesNotMatch(elements.log.innerHTML, /role="alert"/);
});
