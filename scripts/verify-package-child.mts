import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AgentManager } from '../src/manager.ts';
const install=process.argv[2]; if (!install) throw new Error('Pass the temporary npm install prefix');
const root=await mkdtemp(join(tmpdir(),'pi-child-'));const config=join(root,'config'),cwd=join(root,'cwd'),marker=join(root,'marker');await mkdir(config);await mkdir(cwd);await writeFile(marker,'');
process.env.PI_CODING_AGENT_DIR=config;process.env.PI_TEST_MARKER=marker;process.env.PI_SUBAGENTS_CHILD='1';
await writeFile(join(config,'settings.json'),JSON.stringify({packages:[join(install,'node_modules/@caho1/pi-agent-swarm')],extensions:[resolve('tests/fixtures/pi-extension.mjs')]}));
await writeFile(join(config,'mcp.json'),JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[resolve('tests/fixtures/pi-mcp.mjs')],exposure:'direct'}}}));
const runtime=await ModelRuntime.create();const faux=fauxProvider({provider:'faux',models:[{id:'child'}],tokensPerSecond:10000});runtime.registerNativeProvider(faux.provider);const available=runtime.getAvailable.bind(runtime); runtime.getAvailable=(provider,options)=>available(provider ?? 'faux',options);const manager=new AgentManager(runtime,join(root,'data'));
try {
 const call=(name:string,args={})=>faux.appendResponses([fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'}),(ctx)=>fauxAssistantMessage(fauxText(JSON.stringify(ctx.messages.at(-1))))]);
 call('fixture_tool');const agent=await manager.spawn({task:'extension',cwd,model:'faux/child'});await manager.wait([agent.id],'all',10000);assert.match(manager.detail(agent.id).result ?? '',/extension-result/);
 call('mcp__fixture__echo');await manager.followup(agent.id,'mcp');await manager.wait([agent.id],'all',10000);assert.match(manager.detail(agent.id).result ?? '',/mcp-result/);
 call('pi_spawn_agent',{task:'nested'});await manager.followup(agent.id,'nested');await manager.wait([agent.id],'all',10000);assert.match(manager.detail(agent.id).result ?? '',/not found|not available|not allowed/i);
 assert.match(await readFile(marker,'utf8'),/extension-start/);console.log('PASS child real Pi loader preserves other extension and MCP while refusing recursive pi_spawn_agent');
} finally {await manager.close();await rm(root,{recursive:true,force:true});}
