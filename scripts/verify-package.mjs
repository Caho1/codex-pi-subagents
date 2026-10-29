import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai';
import assert from 'node:assert/strict';
process.env.PI_SUBAGENTS_SDK_URL=import.meta.resolve("@earendil-works/pi-coding-agent");
const install = process.argv[2];
if (!install) throw new Error('Pass the temporary npm install prefix');
const root=mkdtempSync(join(tmpdir(),'pi-exec-')); const net=createServer(); net.listen(0,'127.0.0.1'); await once(net,'listening'); const port=net.address().port; await new Promise((resolve, reject) => net.close((error) => error ? reject(error) : resolve()));
process.env.PI_SUBAGENTS_PORT=String(port); process.env.PI_SUBAGENTS_DATA=join(root,'data'); process.env.PI_CODING_AGENT_DIR=join(root,'config'); process.env.PI_SUBAGENTS_FAUX='1';
const server=spawn(process.execPath,[join(install, 'node_modules/@caho1/pi-agents/server.js')],{env:process.env,stdio:'ignore'});
try {
 for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}`)).ok)break}catch{} await new Promise(r=>setTimeout(r,100));}
 writeFileSync(join(root,'settings.json'),JSON.stringify({packages:[join(install, 'node_modules/@caho1/pi-agents')]}));
 const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:SettingsManager.create(root,root)});await loader.reload();const ex=loader.getExtensions().extensions[0];assert.equal(ex.tools.size,7);
 let id='session-a'; const ctx={cwd:root,sessionManager:{getSessionId:()=>id}};
 async function call(name,args){const r=await ex.tools.get(name).definition.execute('x',args,undefined,undefined,ctx);return JSON.parse(r.content[0].text)}
 const runtime = await ModelRuntime.create();
 const faux = fauxProvider({provider:'host-faux', models:[{id:'host'}], tokensPerSecond:10000});
 faux.setResponses([
  fauxAssistantMessage(fauxToolCall('pi_list_models', {include_faux:true}), {stopReason:'toolUse'}),
  fauxAssistantMessage(fauxToolCall('pi_spawn_agent', {}), {stopReason:'toolUse'}),
  fauxAssistantMessage(fauxToolCall('pi_spawn_agent', {task:'agent loop',model:'faux/faux-1'}), {stopReason:'toolUse'}),
  (context) => {
   const result = context.messages.at(-1);
   const agent = JSON.parse(result.content[0].text);
   return fauxAssistantMessage(fauxToolCall('pi_wait', {ids:[agent.id],timeout_sec:10}), {stopReason:'toolUse'});
  },
  fauxAssistantMessage(fauxText('agent loop complete')),
 ]);
 runtime.registerNativeProvider(faux.provider);
 const hostModel=(await runtime.getAvailable('host-faux'))[0];
 const hostManager=SessionManager.inMemory();
 const {session}=await createAgentSession({cwd:root,agentDir:root,model:hostModel,modelRuntime:runtime,sessionManager:hostManager,resourceLoader:loader,noTools:'builtin'});
 await session.bindExtensions({});
 try {
  await session.prompt('Use the Pi tools');
  const results = session.messages.filter((message) => message.role === 'toolResult');
  assert.equal(results.length,4);
  assert.equal(results[1].isError,true);
  assert.ok([results[0],results[2],results[3]].every((result) => !result.isError));
  const spawned = JSON.parse(results[2].content[0].text);
  assert.equal(spawned.codexThreadId,`pi:${hostManager.getSessionId()}`);
  assert.equal(spawned.cwd,root);
  assert.equal(JSON.parse(results[3].content[0].text).agents[0].status,'idle');
 } finally { session.dispose(); }
 const agent=await call('pi_spawn_agent',{task:'hello',model:'faux/faux-1'});assert.equal(agent.cwd,root);assert.equal(agent.codexThreadId,'pi:session-a');
 const waited=await call('pi_wait',{ids:[agent.id],timeout_sec:10});assert.equal(waited.agents[0].status,'idle');
 id='session-b';assert.equal((await call('pi_list_agents',{})).agents.length,0);await assert.rejects(call('pi_get_agent',{id:agent.id}));
 id='session-a';assert.equal((await call('pi_list_agents',{})).agents.length,1);await call('pi_send_followup',{id:agent.id,message:'again'});await call('pi_wait',{ids:[agent.id],timeout_sec:10});
 const another=await call('pi_spawn_agent',{task:'abort',model:'faux/faux-1'});await call('pi_abort',{id:another.id});
 for(const path of ['/','/vendor/marked.js','/vendor/mermaid.js','/vendor/dompurify.js','/fonts/OpenAISans-Regular-c56711d328c4.woff2']) assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status,200,path);
 console.log('PASS Pi AgentSession tool loop, loader, direct spawn/wait/followup/abort, session isolation, cwd, panel assets');
} finally { if (server.exitCode === null && server.signalCode === null) { const stopped=once(server,'exit'); server.kill(); await stopped; } rmSync(root,{recursive:true,force:true}); }
