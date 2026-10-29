import { appendFileSync, existsSync, watch } from 'node:fs';
import { dirname } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
export default function (pi) {
  appendFileSync(process.env.PI_TEST_MARKER, 'extension-start\n');
  pi.on('project_trust', async () => ({ trusted: process.env.PI_TEST_TRUST || 'undecided', remember: true }));
  pi.on('input', async (event) => event.text === 'handled fixture' ? { action: 'handled' } : { action: 'continue' });
  pi.registerTool({ name: 'fixture_tool', label: 'Fixture', description: 'test tool', parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'extension-result' }], details: {} }) });
  pi.on('session_shutdown', async () => {
    const gate = process.env.PI_TEST_SHUTDOWN_GATE;
    if (gate && !existsSync(gate)) {
      appendFileSync(process.env.PI_TEST_MARKER, 'shutdown-enter\n');
      await new Promise((resolve, reject) => {
        const watcher = watch(dirname(gate), () => { if (existsSync(gate)) { clearTimeout(timer); watcher.close(); resolve(); } });
        const timer = setTimeout(() => { watcher.close(); reject(new Error('shutdown barrier timed out')); }, 10000);
        if (existsSync(gate)) { clearTimeout(timer); watcher.close(); resolve(); }
      });
    }
    appendFileSync(process.env.PI_TEST_MARKER, 'extension-stop\n');
  });
}
