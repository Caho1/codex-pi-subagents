import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as tcp } from 'node:net';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
process.env.PI_SUBAGENTS_SDK_URL=import.meta.resolve("@earendil-works/pi-coding-agent");
const install=process.argv[2]; if (!install) throw new Error('Pass the temporary npm install prefix');
const root=mkdtempSync(join(tmpdir(),'pi-cold-')); const net=tcp();net.listen(0,'127.0.0.1');await once(net,'listening');const port=net.address().port;await new Promise((resolve,reject)=>net.close((error)=>error?reject(error):resolve()));
process.env.PI_SUBAGENTS_PORT=String(port);process.env.PI_SUBAGENTS_DATA=join(root,'data');process.env.PI_CODING_AGENT_DIR=join(root,'config');process.env.PI_SUBAGENTS_FAUX='1';
writeFileSync(join(root,'settings.json'),JSON.stringify({packages:[join(install,'node_modules/@caho1/pi-agents')]}));
const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:SettingsManager.create(root,root)});await loader.reload();const tools=loader.getExtensions().extensions[0].tools; const tool=tools.get('pi_list_agents').definition;
const ctx={cwd:root,sessionManager:{getSessionId:()=> 'cold'}};const call=()=>tool.execute('x',{},undefined,undefined,ctx);
let pid;
const listener = () => {
 try { return Number(execFileSync('lsof',['-nP','-t',`-iTCP:${port}`,'-sTCP:LISTEN'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()); }
 catch { return undefined; }
};
async function stop(id) {
 const command = execFileSync('ps',['-p',String(id),'-o','command='],{encoding:'utf8'});
 assert.ok(command.includes(join(install,'node_modules/@caho1/pi-agents/server.js')),'refusing to stop an unrelated service');
 process.kill(id, 'SIGTERM');
 const deadline = Date.now()+5000;
 while (listener() === id && Date.now() < deadline) await new Promise(resolve=>setTimeout(resolve,50));
 assert.notEqual(listener(),id,'service listener did not exit');
}
try {
 const result=await Promise.all([call(),call()]);assert.equal(result.length,2);
 pid=Number(execFileSync('lsof',['-nP','-t',`-iTCP:${port}`,'-sTCP:LISTEN'],{encoding:'utf8'}).trim());assert.ok(pid);assert.match(execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8'}),/pi-agents\/server.js/);
 await call();
 const agent = JSON.parse((await tools.get('pi_spawn_agent').definition.execute('x',{task:'persist',model:'faux/faux-1'},undefined,undefined,ctx)).content[0].text);
 await tools.get('pi_wait').definition.execute('x',{ids:[agent.id],timeout_sec:10},undefined,undefined,ctx);
 const conflict=spawn(process.execPath,[join(install,'node_modules/@caho1/pi-agents/server.js'),'--stdio'],{env:process.env,stdio:'ignore'});const [code]=await once(conflict,'exit');assert.equal(code,1);process.kill(pid,0);
 const oldPid=pid;await stop(pid);pid=undefined;
 const restored=JSON.parse((await call()).content[0].text);assert.ok(restored.agents.some((a)=>a.id===agent.id));
 pid=listener();assert.ok(pid);assert.notEqual(pid,oldPid);await stop(pid);pid=undefined;
 let requests=0;const other=createServer((req,res)=>{requests++;res.end('foreign')});other.listen(port,'127.0.0.1');await once(other,'listening');
 await assert.rejects(call(),/Cannot connect|occupied/);assert.ok(requests);assert.ok(other.listening);other.close();await once(other,'close');
 console.log('PASS concurrent cold start, reuse, --stdio port conflict, restart recovery and foreign port refusal');
} finally {if(pid)await stop(pid);rmSync(root,{recursive:true,force:true})}
