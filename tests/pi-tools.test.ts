import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime, ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { AgentManager } from '../src/manager.ts';

async function waitForMarker(marker: string, text: string, count: number) {
 const { watch } = await import('node:fs');
 const watcher = watch(marker);
 let changed = false, wake: (() => void) | undefined;
 const deadline = Date.now() + 10000;
 watcher.on('change', () => { changed = true; wake?.(); });
 try {
  for (;;) {
   changed = false;
   const contents = await readFile(marker, 'utf8');
   if (contents.split(text).length - 1 >= count) return;
   if (Date.now() >= deadline) throw new Error(`timed out waiting for ${text}; marker: ${contents}`);
   if (changed) continue;
   await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { wake = undefined; resolve(); }, 100);
    wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
    if (changed) wake();
   });
  }
 } finally { watcher.close(); }
}

test('configured tools execute, reopen, obey trust and read-only, and close', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-tools-'));
 const config = join(root, 'config'), cwd = join(root, 'project'), data = join(root, 'data'), marker = join(root, 'marker');
 await Promise.all([mkdir(config), mkdir(cwd), mkdir(data), writeFile(marker, '')]);
 const oldDir = process.env.PI_CODING_AGENT_DIR, oldMarker = process.env.PI_TEST_MARKER;
 process.env.PI_CODING_AGENT_DIR = config; process.env.PI_TEST_MARKER = marker;
 const ext = resolve('tests/fixtures/pi-extension.mjs');
 await writeFile(join(config, 'settings.json'), JSON.stringify({ extensions: [ext] }));
 await writeFile(join(config, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [resolve('tests/fixtures/pi-mcp.mjs')], exposure: 'direct' } } }));
 let manager: AgentManager | undefined;
 try {
  const runtime = await ModelRuntime.create();
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'fixture' }], tokensPerSecond: 10000 });
  runtime.registerNativeProvider(faux.provider);
  const getAvailable = runtime.getAvailable.bind(runtime);
  runtime.getAvailable = (provider, options) => getAvailable(provider ?? 'faux', options);
  const call = (name: string) => { faux.appendResponses([fauxAssistantMessage(fauxToolCall(name, {}), { stopReason: 'toolUse' }), (ctx) => fauxAssistantMessage(fauxText(JSON.stringify(ctx.messages.at(-1))))]); };
  manager = new AgentManager(runtime, data);
  call('fixture_tool');
  const agent = await manager.spawn({ task: 'extension', cwd, model: 'faux/fixture' });
  await manager.wait([agent.id], 'all', 10000);
  assert.match(manager.detail(agent.id).result ?? '', /extension-result/);
  call('mcp__fixture__echo');
  await manager.followup(agent.id, 'mcp'); await manager.wait([agent.id], 'all', 10000);
  assert.match(manager.detail(agent.id).result ?? '', /mcp-result/);
  await waitForMarker(marker, 'mcp-stop', 1);
  let history = '';
  faux.appendResponses([
   fauxAssistantMessage(fauxToolCall('mcp__fixture__echo', {}), { stopReason: 'toolUse' }),
   (ctx) => { history = JSON.stringify(ctx.messages); return fauxAssistantMessage(fauxText(JSON.stringify(ctx.messages.at(-1)))); },
  ]);
  await manager.followup(agent.id, 'mcp again'); await manager.wait([agent.id], 'all', 10000);
  assert.match(manager.detail(agent.id).result ?? '', /mcp-result/);
  assert.match(history, /extension-result/);
  await waitForMarker(marker, 'mcp-stop', 3);
  assert.equal((await readFile(marker, 'utf8')).split('mcp-start').length - 1, 3);
  await manager.close();
  const stopped = await readFile(marker, 'utf8');
  assert.match(stopped, /extension-stop/);
  assert.match(stopped, /mcp-stop/);
  manager = new AgentManager(runtime, data);
  call('fixture_tool');
  await manager.followup(agent.id, 'resume'); await manager.wait([agent.id], 'all', 10000);
  assert.match(manager.detail(agent.id).result ?? '', /extension-result/);
  await manager.close();
  const before = await readFile(marker, 'utf8');
  manager = new AgentManager(runtime, join(root, 'readonly-data'));
  faux.appendResponses([fauxAssistantMessage(fauxText('read only'))]);
  const readonly = await manager.spawn({ task: 'read only', cwd, model: 'faux/fixture', tools: 'read-only' });
  await manager.wait([readonly.id], 'all', 10000);
  for (const name of ['fixture_tool', 'mcp__fixture__echo', 'write']) {
   call(name); await manager.followup(readonly.id, name); await manager.wait([readonly.id], 'all', 10000);
   assert.match(manager.detail(readonly.id).result ?? '', /not found|not available|not allowed/i);
  }
  await manager.close();
  assert.equal(await readFile(marker, 'utf8'), before);
  await mkdir(join(cwd, '.pi', 'extensions'), { recursive: true });
  await writeFile(join(cwd, '.pi', 'extensions', 'project.js'), `export default function(pi) { pi.registerTool({name:'project_tool',label:'Project',description:'project',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'project-result'}],details:{}})}); }`);
  const trust = new ProjectTrustStore(config); trust.set(cwd, false);
  manager = new AgentManager(runtime, join(root, 'trust-data'));
  call('project_tool'); const denied = await manager.spawn({ task: 'denied', cwd, model: 'faux/fixture' });
  await manager.wait([denied.id], 'all', 10000); assert.doesNotMatch(manager.detail(denied.id).result ?? '', /project-result/); await manager.close();
  process.env.PI_TEST_TRUST = 'yes';
  trust.set(cwd, false);
  manager = new AgentManager(runtime, join(root, 'trusted-data'));
  call('project_tool'); const allowed = await manager.spawn({ task: 'allowed', cwd, model: 'faux/fixture' });
  await manager.wait([allowed.id], 'all', 10000); assert.match(manager.detail(allowed.id).result ?? '', /project-result/);
  assert.equal(trust.get(cwd), true);
 } finally {
  await manager?.close();
  delete process.env.PI_TEST_TRUST;
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldMarker === undefined) delete process.env.PI_TEST_MARKER; else process.env.PI_TEST_MARKER = oldMarker;
  await rm(root, { recursive: true, force: true });
 }
});

test('handled first input persists a session that can be reopened', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-handled-reopen-'));
 const config = join(root, 'config'), cwd = join(root, 'project'), data = join(root, 'data'), marker = join(root, 'marker');
 await Promise.all([mkdir(config), mkdir(cwd), writeFile(marker, '')]);
 const oldDir = process.env.PI_CODING_AGENT_DIR, oldMarker = process.env.PI_TEST_MARKER;
 process.env.PI_CODING_AGENT_DIR = config; process.env.PI_TEST_MARKER = marker;
 await writeFile(join(config, 'settings.json'), JSON.stringify({ extensions: [resolve('tests/fixtures/pi-extension.mjs')] }));
 let manager: AgentManager | undefined;
 try {
  const runtime = await ModelRuntime.create();
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'fixture' }], tokensPerSecond: 10000 });
  runtime.registerNativeProvider(faux.provider);
  const available = runtime.getAvailable.bind(runtime);
  runtime.getAvailable = (provider, options) => available(provider ?? 'faux', options);
  manager = new AgentManager(runtime, data);
  const agent = await manager.spawn({ task: 'handled fixture', cwd, model: 'faux/fixture' });
  await manager.wait([agent.id], 'all', 10000);
  await waitForMarker(marker, 'extension-stop', 1);
  const sessionFile = agent.sessionFile!;
  await manager.close();
  assert.match(await readFile(sessionFile, 'utf8'), /"type":"session"/);
  manager = new AgentManager(runtime, data);
  faux.appendResponses([fauxAssistantMessage(fauxText('reopened'))]);
  await manager.followup(agent.id, 'continue');
  await manager.wait([agent.id], 'all', 10000);
  assert.equal(manager.detail(agent.id).result, 'reopened');
  assert.equal(manager.detail(agent.id).sessionFile, sessionFile);
 } finally {
  await manager?.close();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldMarker === undefined) delete process.env.PI_TEST_MARKER; else process.env.PI_TEST_MARKER = oldMarker;
  await rm(root, { recursive: true, force: true });
 }
});

test('one agent exits its MCP process without interrupting another agent', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-mcp-isolation-'));
 const config = join(root, 'config'), cwd = join(root, 'project'), marker = join(root, 'marker');
 await Promise.all([mkdir(config), mkdir(cwd), writeFile(marker, '')]);
 const oldDir = process.env.PI_CODING_AGENT_DIR, oldMarker = process.env.PI_TEST_MARKER;
 process.env.PI_CODING_AGENT_DIR = config; process.env.PI_TEST_MARKER = marker;
 await writeFile(join(config, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [resolve('tests/fixtures/pi-mcp.mjs')], exposure: 'direct' } } }));
 let manager: AgentManager | undefined;
 let releaseA!: () => void, releaseB!: () => void;
 const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
 const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
 try {
  const runtime = await ModelRuntime.create();
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'fixture' }], tokensPerSecond: 10000 });
  runtime.registerNativeProvider(faux.provider);
  const available = runtime.getAvailable.bind(runtime);
  runtime.getAvailable = (provider, options) => available(provider ?? 'faux', options);
  faux.appendResponses([
   async () => { await gateA; return fauxAssistantMessage(fauxText('agent A done')); },
   async () => { await gateB; return fauxAssistantMessage(fauxToolCall('mcp__fixture__echo', {}), { stopReason: 'toolUse' }); },
   (ctx) => fauxAssistantMessage(fauxText(JSON.stringify(ctx.messages.at(-1)))),
  ]);
  manager = new AgentManager(runtime, join(root, 'data'));
  const a = await manager.spawn({ task: 'agent A', cwd, model: 'faux/fixture' });
  await waitForMarker(marker, 'mcp-start', 1);
  const b = await manager.spawn({ task: 'agent B', cwd, model: 'faux/fixture' });
  await waitForMarker(marker, 'mcp-start', 2);
  const pids = [...(await readFile(marker, 'utf8')).matchAll(/mcp-start (\d+)/g)].map((match) => Number(match[1]));
  assert.equal(pids.length, 2);
  releaseA();
  await manager.wait([a.id], 'all', 10000);
  await waitForMarker(marker, `mcp-stop ${pids[0]}`, 1);
  await new Promise<void>((resolve, reject) => {
   const deadline = Date.now() + 10000;
   const check = () => {
    try { process.kill(pids[0]!, 0); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ESRCH') { resolve(); return; } reject(err); return; }
    if (Date.now() >= deadline) { reject(new Error('MCP process did not exit')); return; }
    setTimeout(check, 20);
   };
   check();
  });
  process.kill(pids[1]!, 0);
  releaseB();
  await manager.wait([b.id], 'all', 10000);
  assert.match(manager.detail(b.id).result ?? '', /mcp-result/);
  await waitForMarker(marker, `mcp-stop ${pids[1]}`, 1);
 } finally {
  releaseA(); releaseB();
  await manager?.close();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldMarker === undefined) delete process.env.PI_TEST_MARKER; else process.env.PI_TEST_MARKER = oldMarker;
  await rm(root, { recursive: true, force: true });
 }
});

test('aborted agent closes its MCP and reconnects for a follow-up', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-abort-mcp-'));
 const config = join(root, 'config'), cwd = join(root, 'project'), marker = join(root, 'marker');
 await Promise.all([mkdir(config), mkdir(cwd), writeFile(marker, '')]);
 const oldDir = process.env.PI_CODING_AGENT_DIR, oldMarker = process.env.PI_TEST_MARKER;
 process.env.PI_CODING_AGENT_DIR = config; process.env.PI_TEST_MARKER = marker;
 await writeFile(join(config, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [resolve('tests/fixtures/pi-mcp.mjs')], exposure: 'direct' } } }));
 let manager: AgentManager | undefined;
 try {
  const runtime = await ModelRuntime.create();
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'fixture' }], tokensPerSecond: 100 });
  runtime.registerNativeProvider(faux.provider);
  const available = runtime.getAvailable.bind(runtime);
  runtime.getAvailable = (provider, options) => available(provider ?? 'faux', options);
  faux.appendResponses([fauxAssistantMessage(fauxText('long response '.repeat(4000)))]);
  manager = new AgentManager(runtime, join(root, 'data'));
  const agent = await manager.spawn({ task: 'run until stopped', cwd, model: 'faux/fixture' });
  await waitForMarker(marker, 'mcp-listed', 1);
  assert.equal(manager.detail(agent.id).status, 'running');
  assert.equal((await manager.abort(agent.id)).status, 'aborted');
  await waitForMarker(marker, 'mcp-stop', 1);
  faux.appendResponses([
   fauxAssistantMessage(fauxToolCall('mcp__fixture__echo', {}), { stopReason: 'toolUse' }),
   (ctx) => fauxAssistantMessage(fauxText(JSON.stringify(ctx.messages.at(-1)))),
  ]);
  await manager.followup(agent.id, 'continue');
  await manager.wait([agent.id], 'all', 10000);
  assert.match(manager.detail(agent.id).result ?? '', /mcp-result/);
  await waitForMarker(marker, 'mcp-stop', 2);
  assert.equal((await readFile(marker, 'utf8')).split('mcp-start').length - 1, 2);
 } finally {
  await manager?.close();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldMarker === undefined) delete process.env.PI_TEST_MARKER; else process.env.PI_TEST_MARKER = oldMarker;
  await rm(root, { recursive: true, force: true });
 }
});

test('synchronous idle follow-ups wait for shutdown and share one reopened session', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-shutdown-barrier-'));
 const config = join(root, 'config'), cwd = join(root, 'project'), marker = join(root, 'marker'), gate = join(root, 'release');
 await Promise.all([mkdir(config), mkdir(cwd), writeFile(marker, '')]);
 const oldDir = process.env.PI_CODING_AGENT_DIR, oldMarker = process.env.PI_TEST_MARKER, oldGate = process.env.PI_TEST_SHUTDOWN_GATE;
 process.env.PI_CODING_AGENT_DIR = config; process.env.PI_TEST_MARKER = marker; process.env.PI_TEST_SHUTDOWN_GATE = gate;
 await writeFile(join(config, 'settings.json'), JSON.stringify({ extensions: [resolve('tests/fixtures/pi-extension.mjs')] }));
 let manager: AgentManager | undefined;
 let followups: Promise<unknown>[] = [];
 try {
  const runtime = await ModelRuntime.create();
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'fixture' }], tokensPerSecond: 10000 });
  runtime.registerNativeProvider(faux.provider);
  const available = runtime.getAvailable.bind(runtime);
  runtime.getAvailable = (provider, options) => available(provider ?? 'faux', options);
  faux.appendResponses(['first result', 'second result', 'third result'].map((value) => fauxAssistantMessage(fauxText(value))));
  manager = new AgentManager(runtime, join(root, 'data'));
  manager.on('agent', (info) => {
   if (info.status === 'idle' && followups.length === 0) {
    followups = [manager!.followup(info.id, 'second message'), manager!.followup(info.id, 'third message')];
   }
  });
  const agent = await manager.spawn({ task: 'first message', cwd, model: 'faux/fixture' });
  await waitForMarker(marker, 'shutdown-enter', 1);
  assert.equal(followups.length, 2);
  assert.equal((await readFile(marker, 'utf8')).split('extension-start').length - 1, 1);
  assert.deepEqual(manager.detail(agent.id).log.filter((line) => line.kind === 'user').map((line) => line.text), ['first message']);
  await writeFile(gate, 'release');
  await Promise.all(followups);
  await manager.wait([agent.id], 'all', 10000);
  const log = manager.detail(agent.id).log;
  assert.deepEqual(log.filter((line) => line.kind === 'user').map((line) => line.text), ['first message', 'second message', 'third message']);
  assert.equal((await readFile(marker, 'utf8')).split('extension-start').length - 1, 2);
  assert(log.some((line) => line.kind === 'assistant' && line.text === 'third result'));
  await Promise.all([manager.close(), manager.close()]);
  assert.equal((await readFile(marker, 'utf8')).split('extension-stop').length - 1, 2);
 } finally {
  await writeFile(gate, 'release');
  await Promise.allSettled(followups);
  await manager?.close();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldMarker === undefined) delete process.env.PI_TEST_MARKER; else process.env.PI_TEST_MARKER = oldMarker;
  if (oldGate === undefined) delete process.env.PI_TEST_SHUTDOWN_GATE; else process.env.PI_TEST_SHUTDOWN_GATE = oldGate;
  await rm(root, { recursive: true, force: true });
 }
});

test('failed task shuts down MCP while concurrent close calls wait for it', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-error-shutdown-'));
 const config = join(root, 'config'), cwd = join(root, 'project'), marker = join(root, 'marker'), gate = join(root, 'release');
 await Promise.all([mkdir(config), mkdir(cwd), writeFile(marker, '')]);
 const oldDir = process.env.PI_CODING_AGENT_DIR, oldMarker = process.env.PI_TEST_MARKER, oldGate = process.env.PI_TEST_SHUTDOWN_GATE;
 process.env.PI_CODING_AGENT_DIR = config; process.env.PI_TEST_MARKER = marker; process.env.PI_TEST_SHUTDOWN_GATE = gate;
 await writeFile(join(config, 'settings.json'), JSON.stringify({ extensions: [resolve('tests/fixtures/pi-extension.mjs')] }));
 await writeFile(join(config, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [resolve('tests/fixtures/pi-mcp.mjs')], exposure: 'direct' } } }));
 let manager: AgentManager | undefined;
 try {
  const runtime = await ModelRuntime.create();
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'fixture' }], tokensPerSecond: 10000 });
  runtime.registerNativeProvider(faux.provider);
  const available = runtime.getAvailable.bind(runtime);
  runtime.getAvailable = (provider, options) => available(provider ?? 'faux', options);
  faux.appendResponses([fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'fixture failure' })]);
  manager = new AgentManager(runtime, join(root, 'data'));
  const agent = await manager.spawn({ task: 'fail', cwd, model: 'faux/fixture' });
  await manager.wait([agent.id], 'all', 10000);
  assert.match(manager.detail(agent.id).error ?? '', /fixture failure/);
  await waitForMarker(marker, 'shutdown-enter', 1);
  const first = manager.close(), second = manager.close();
  let closed = false;
  void first.then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  await writeFile(gate, 'release');
  await Promise.all([first, second]);
  await waitForMarker(marker, 'mcp-stop', 1);
  assert.equal((await readFile(marker, 'utf8')).split('extension-stop').length - 1, 1);
 } finally {
  await writeFile(gate, 'release');
  await manager?.close();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldMarker === undefined) delete process.env.PI_TEST_MARKER; else process.env.PI_TEST_MARKER = oldMarker;
  if (oldGate === undefined) delete process.env.PI_TEST_SHUTDOWN_GATE; else process.env.PI_TEST_SHUTDOWN_GATE = oldGate;
  await rm(root, { recursive: true, force: true });
 }
});

test('default codemode and deferred MCP tools can be called', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-exposure-'));
 const config = join(root, 'config'), cwd = join(root, 'project'), marker = join(root, 'marker');
 await Promise.all([mkdir(config), mkdir(cwd), writeFile(marker, '')]);
 const oldDir = process.env.PI_CODING_AGENT_DIR, oldMarker = process.env.PI_TEST_MARKER;
 process.env.PI_CODING_AGENT_DIR = config; process.env.PI_TEST_MARKER = marker;
 const command = { command: process.execPath, args: [resolve('tests/fixtures/pi-mcp.mjs')] };
 await writeFile(join(config, 'mcp.json'), JSON.stringify({ mcpServers: { codefixture: command, deferredfixture: { ...command, exposure: 'deferred' } } }));
 let manager: AgentManager | undefined;
 try {
  const runtime = await ModelRuntime.create();
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'fixture' }], tokensPerSecond: 10000 });
  runtime.registerNativeProvider(faux.provider);
  const getAvailable = runtime.getAvailable.bind(runtime);
  runtime.getAvailable = (provider, options) => getAvailable(provider ?? 'faux', options);
  faux.appendResponses([
   async () => { await waitForMarker(marker, 'mcp-listed', 2); return fauxAssistantMessage(fauxToolCall('codemode', { code: 'text(await tools.mcp__codefixture__echo({}))' }), { stopReason: 'toolUse' }); },
   (ctx) => fauxAssistantMessage(fauxText(JSON.stringify(ctx.messages.at(-1)))),
  ]);
  manager = new AgentManager(runtime, join(root, 'data'));
  const agent = await manager.spawn({ task: 'codemode', cwd, model: 'faux/fixture' });
  await manager.wait([agent.id], 'all', 15000);
  assert.match(manager.detail(agent.id).result ?? '', /mcp-result/);
  faux.appendResponses([
   fauxAssistantMessage(fauxToolCall('tool_search', { query: 'fixture echo' }), { stopReason: 'toolUse' }),
   fauxAssistantMessage(fauxToolCall('mcp__deferredfixture__echo', {}), { stopReason: 'toolUse' }),
   (ctx) => fauxAssistantMessage(fauxText(JSON.stringify(ctx.messages.at(-1)))),
  ]);
  await manager.followup(agent.id, 'search and call'); await manager.wait([agent.id], 'all', 15000);
  assert.match(manager.detail(agent.id).result ?? '', /mcp-result/);
  assert(manager.detail(agent.id).log.some((entry) => entry.kind === 'tool' && entry.text.startsWith('tool_search ')));
 } finally {
  await manager?.close();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldMarker === undefined) delete process.env.PI_TEST_MARKER; else process.env.PI_TEST_MARKER = oldMarker;
  await rm(root, { recursive: true, force: true });
 }
});

test('trust decisions cannot fall back to allow when saving fails or a value is invalid', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pi-trust-failure-'));
 const config = join(root, 'config'), cwd = join(root, 'project'), marker = join(root, 'marker');
 await Promise.all([mkdir(config), mkdir(cwd), writeFile(marker, '')]);
 await mkdir(join(cwd, '.pi', 'extensions'), { recursive: true });
 await writeFile(join(cwd, '.pi', 'extensions', 'project.js'), `export default function(pi) { pi.registerTool({name:'project_tool',label:'Project',description:'project',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'project-result'}],details:{}})}); }`);
 await writeFile(join(config, 'settings.json'), JSON.stringify({ extensions: [resolve('tests/fixtures/pi-extension.mjs')], defaultProjectTrust: 'always' }));
 const oldDir = process.env.PI_CODING_AGENT_DIR, oldMarker = process.env.PI_TEST_MARKER, oldTrust = process.env.PI_TEST_TRUST;
 const setTrust = ProjectTrustStore.prototype.set;
 process.env.PI_CODING_AGENT_DIR = config; process.env.PI_TEST_MARKER = marker;
 let manager: AgentManager | undefined;
 try {
  const runtime = await ModelRuntime.create();
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'fixture' }], tokensPerSecond: 10000 });
  runtime.registerNativeProvider(faux.provider);
  const getAvailable = runtime.getAvailable.bind(runtime);
  runtime.getAvailable = (provider, options) => getAvailable(provider ?? 'faux', options);
  const store = new ProjectTrustStore(config);
  store.set(cwd, true);
  process.env.PI_TEST_TRUST = 'no';
  ProjectTrustStore.prototype.set = () => { throw new Error('trust store write failed'); };
  manager = new AgentManager(runtime, join(root, 'failed-data'));
  await assert.rejects(manager.spawn({ task: 'must fail', cwd, model: 'faux/fixture' }), /trust store write failed/);
  assert.equal(manager.list().length, 0);
  ProjectTrustStore.prototype.set = setTrust;
  process.env.PI_TEST_TRUST = 'invalid';
  faux.appendResponses([
   fauxAssistantMessage(fauxToolCall('project_tool', {}), { stopReason: 'toolUse' }),
   (ctx) => fauxAssistantMessage(fauxText(JSON.stringify(ctx.messages.at(-1)))),
  ]);
  manager = new AgentManager(runtime, join(root, 'invalid-data'));
  const agent = await manager.spawn({ task: 'invalid decision', cwd, model: 'faux/fixture' });
  await manager.wait([agent.id], 'all', 10000);
  assert.match(manager.detail(agent.id).result ?? '', /not found/);
  assert.equal(store.get(cwd), false);
 } finally {
  ProjectTrustStore.prototype.set = setTrust;
  await manager?.close();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (oldMarker === undefined) delete process.env.PI_TEST_MARKER; else process.env.PI_TEST_MARKER = oldMarker;
  if (oldTrust === undefined) delete process.env.PI_TEST_TRUST; else process.env.PI_TEST_TRUST = oldTrust;
  await rm(root, { recursive: true, force: true });
 }
});
