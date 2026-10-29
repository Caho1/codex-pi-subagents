import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const install = process.argv[2];
if (!install) throw new Error('Pass the temporary npm install prefix');
const root = mkdtempSync(join(tmpdir(), 'pi-proxy-'));
const socket = createTcpServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((done) => socket.close(done));
let proxyRequests = 0;
const proxy = createServer((_request, response) => { proxyRequests++; response.writeHead(502).end(); });
proxy.on('connect', (_request, connection) => { proxyRequests++; connection.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
proxy.listen(0, '127.0.0.1');
await once(proxy, 'listening');
const proxyURL = `http://127.0.0.1:${proxy.address().port}`;
const marker = join(root, 'result.json');
const packagePath = join(install, 'node_modules/@caho1/pi-agent-swarm');
writeFileSync(join(root, 'settings.json'), JSON.stringify({ packages: [packagePath] }));
writeFileSync(join(root, 'probe.mjs'), `
import extension from ${JSON.stringify(pathToFileURL(join(packagePath, 'extension.js')).href)};
import { writeFileSync } from 'node:fs';
export default function (pi) {
  let tool;
  extension({ registerTool(definition) { if (definition.name === 'pi_list_agents') tool = definition; } });
  pi.on('session_start', async (_event, ctx) => {
    try {
      const result = await tool.execute('probe', {}, undefined, undefined, ctx);
      let proxyRejected = false;
      try { await globalThis.fetch('http://outside.example.test/'); } catch { proxyRejected = true; }
      writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ result, proxyRejected }));
    } catch (error) { writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ error: error.stack })); }
  });
}
`);
const env = { ...process.env, HTTP_PROXY: proxyURL, HTTPS_PROXY: proxyURL, http_proxy: proxyURL, https_proxy: proxyURL, PI_SUBAGENTS_PORT: String(port), PI_SUBAGENTS_DATA: join(root, 'data'), PI_CODING_AGENT_DIR: root, PI_SUBAGENTS_FAUX: '1' };
delete env.NO_PROXY;
delete env.no_proxy;
delete env.PI_SUBAGENTS_SDK_URL;
const child = spawn(process.execPath, [resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--mode', 'rpc', '--no-session', '--extension', join(root, 'probe.mjs')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
try {
  for (let i = 0; i < 150 && !existsSync(marker) && child.exitCode === null; i++) await new Promise((done) => setTimeout(done, 100));
  assert.ok(existsSync(marker), `Pi CLI did not finish probe: ${output}`);
  const result = JSON.parse(readFileSync(marker, 'utf8'));
  assert.ifError(result.error);
  assert.ok(result.result.content.length, 'local MCP call returned content');
  assert.equal(result.proxyRejected, true, 'global fetch still uses the rejecting proxy');
  assert.ok(proxyRequests > 0, 'proxy received the global fetch request');
  console.log('PASS real Pi CLI local MCP cold start bypasses proxy; global fetch retains proxy');
} finally {
  if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
  let pid;
  try { pid = Number(execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch {}
  if (pid) {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    assert.ok(command.includes(join(packagePath, 'server.js')), 'refusing to stop an unrelated service');
    process.kill(pid, 'SIGTERM');
    let stopped = false;
    for (let i = 0; i < 100; i++) {
      try { execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'ignore' }); }
      catch { stopped = true; break; }
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(stopped, 'test service did not stop');
  }
  await new Promise((done) => proxy.close(done));
  rmSync(root, { recursive: true, force: true });
}
