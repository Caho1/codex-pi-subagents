import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
process.env.PI_SUBAGENTS_SDK_URL=import.meta.resolve("@earendil-works/pi-coding-agent");
const install=process.argv[2]; if (!install) throw new Error('Pass the temporary npm install prefix');
const root=mkdtempSync(join(tmpdir(),'pi-slow-'));process.env.PI_SUBAGENTS_DATA=join(root,'data');process.env.PI_CODING_AGENT_DIR=join(root,'config');process.env.PI_SUBAGENTS_FAUX='1';
const slow=createServer((req,res)=>res.writeHead(503).end('service starting'));slow.listen(0,'127.0.0.1');await once(slow,'listening');process.env.PI_SUBAGENTS_PORT=String(slow.address().port);
writeFileSync(join(root,'settings.json'),JSON.stringify({packages:[join(install,'node_modules/@caho1/pi-agents')]}));const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:SettingsManager.create(root,root)});await loader.reload();
const tool=loader.getExtensions().extensions[0].tools.get('pi_list_agents').definition;let child;
try {
 const result=tool.execute('x',{},undefined,undefined,{cwd:root,sessionManager:{getSessionId:()=> 'slow'}});
 await new Promise(resolve=>setTimeout(resolve,2200));await new Promise(resolve=>slow.close(resolve));
 child=spawn(process.execPath,[join(install,'node_modules/@caho1/pi-agents/server.js')],{env:process.env,stdio:'ignore'});
 await result;console.log('PASS waits for service initializing longer than two seconds');
} finally {if(child && child.exitCode === null && child.signalCode === null){const done=once(child,'exit');child.kill();await done;} if(slow.listening)slow.close();rmSync(root,{recursive:true,force:true});}
