import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("snapshot watermark excludes buffered and delayed stream events", async () => {
 const html = await readFile(new URL("../src/panel.html", import.meta.url), "utf8");
 const selection = html.slice(html.indexOf("let hydration = null;"), html.indexOf('\n$("abort").innerHTML'));
 const stream = html.slice(html.indexOf("function applyStream(event)"), html.indexOf('es.addEventListener("log", onStream);'));
 let release!: (value: unknown) => void;
 const response = new Promise((resolve) => { release = resolve; });
 const context = {
  agents: new Map([["a", {}], ["b", {}]]), selectionVersion: 0, sel: null,
  lines: [], draft: "", location: { hash: "", pathname: "/" }, history: { replaceState() {} },
  renderList() {}, renderDetail() {}, fetch: () => response as Promise<any>,
 };
 const api = runInNewContext(`${selection}\n${stream}\n({ select, onStream, state: () => ({ lines, draft, lastRevision }) })`, context);
 const pending = api.select("a");
 api.onStream({ data: JSON.stringify({ id: "a", revision: 2, delta: "buffered-old" }) });
 api.onStream({ data: JSON.stringify({ id: "a", revision: 4, delta: "new" }) });
 release({ ok: true, json: async () => ({ log: [{ text: "snapshot" }], draft: "base", revision: 3 }) });
 await pending;
 api.onStream({ data: JSON.stringify({ id: "a", revision: 3, delta: "delayed-old" }) });
 api.onStream({ data: JSON.stringify({ id: "a", revision: 4, delta: "duplicate" }) });
 api.onStream({ data: JSON.stringify({ id: "a", revision: 5, delta: "latest" }) });
 assert.equal(api.state().draft, "basenewlatest");
 assert.equal(api.state().lines.length, 1);
 assert.equal(api.state().lastRevision, 5);
 let reconnect!: (value: unknown) => void;
 context.fetch = () => new Promise((resolve) => { reconnect = resolve; });
 const reconnecting = api.select("a");
 api.onStream({ data: JSON.stringify({ id: "a", revision: 1, delta: "replayed" }) });
 reconnect({ ok: true, json: async () => ({ log: [], draft: "reconnected", revision: 1 }) });
 await reconnecting;
 api.onStream({ data: JSON.stringify({ id: "a", revision: 2, delta: "-next" }) });
 assert.equal(api.state().draft, "reconnected-next");
 let switched!: (value: unknown) => void;
 context.fetch = () => new Promise((resolve) => { switched = resolve; });
 const selecting = api.select("b");
 switched({ ok: true, json: async () => ({ log: [], draft: "other", revision: 0 }) });
 await selecting;
 api.onStream({ data: JSON.stringify({ id: "b", revision: 1, delta: "-first" }) });
 assert.equal(api.state().draft, "other-first");
});
