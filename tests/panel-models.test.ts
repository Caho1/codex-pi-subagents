import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("unavailable model preference is visible until the user chooses a replacement", async () => {
 const html = await readFile(new URL("../src/panel.html", import.meta.url), "utf8");
 const source = html.slice(html.indexOf("async function loadModels()"), html.indexOf("\nloadModels();"));
 const children: any[] = [];
 const select = {
  disabled: false, value: "", onchange: async () => {},
  set innerHTML(_: string) { children.length = 0; },
  append: (child: unknown) => children.push(child),
  prepend: (child: unknown) => children.unshift(child),
 };
 const status = { hidden: true, textContent: "" };
 const count = { textContent: "" };
 const requests: any[] = [];
 const elements: Record<string, unknown> = { "model-select": select, "model-status": status, "model-count": count };
 const load = runInNewContext(`${source}; loadModels`, {
  $: (id: string) => elements[id],
  document: { createElement: () => ({ append() {}, value: "", textContent: "", disabled: false }) },
  fetch: async (_url: string, options?: any) => {
   if (options) { requests.push(JSON.parse(options.body)); return { ok: true }; }
   return { ok: true, json: async () => ({ models: [{ id: "provider/new", name: "New" }], preferred: "provider/old" }) };
  },
 });
 await load();
 assert.equal(select.value, "provider/old");
 assert.equal(children[0].disabled, true);
 assert.match(children[0].textContent, /不可用/);
 assert.equal(status.hidden, false);
 assert.match(status.textContent, /不可用/);
 assert.equal(requests.length, 0);
 select.value = "provider/new";
 await select.onchange();
 assert.equal(requests[0].model, "provider/new");
 assert.equal(status.hidden, true);
});
