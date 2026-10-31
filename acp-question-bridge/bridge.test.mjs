import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';

test('question waits for explicit selection, maps choice and cancels invalid answers', async () => {
 const dir = await mkdtemp(join(tmpdir(),'cc-bridge-'));
 try {
  const fake=join(dir,'fake');
  await writeFile(fake,`#!/usr/bin/env node\nprocess.stdin.on('data',d=>process.stdout.write(d));\n`); await chmod(fake,0o755);
  const p=spawn(process.execPath,['acp-question-bridge/bridge.mjs'],{env:{...process.env,COMMAND_CODE_BINARY:fake},stdio:['pipe','pipe','inherit']});
  const queue=[]; let wake;
  createInterface({input:p.stdout}).on('line',l=>{queue.push(JSON.parse(l));wake?.();});
  const next=async()=>{while(!queue.length)await new Promise(r=>wake=r);wake=null;return queue.shift()};
  const send=x=>p.stdin.write(JSON.stringify(x)+'\n');
  const request=(id)=>({jsonrpc:'2.0',id,method:'session/request_permission',params:{sessionId:'s',toolCall:{toolCallId:'q',kind:'other',rawInput:{question:'Which?',options:['A (Recommended)','B','C']}},options:['A (Recommended)','B','C'].map((name,i)=>({optionId:`option_${i}`,kind:'allow_once',name}))}});
  send(request(10)); const q=await next();assert.equal(q.method,'elicitation/create');assert.deepEqual(q.params.requestedSchema.properties.answer.enum,['A (Recommended)','B','C']);
  send({jsonrpc:'2.0',id:q.id,result:{action:'accept',content:{answer:'C'}}});assert.deepEqual((await next()).result.outcome,{outcome:'selected',optionId:'option_2'});
  send(request(11)); const q2=await next();send({jsonrpc:'2.0',id:q2.id,result:{action:'accept',content:{answer:'custom'}}});assert.deepEqual((await next()).result.outcome,{outcome:'cancelled'});
  send(request(12)); const q3=await next();send({jsonrpc:'2.0',id:q3.id,result:{action:'cancel'}});assert.deepEqual((await next()).result.outcome,{outcome:'cancelled'});
  const normal={jsonrpc:'2.0',id:13,method:'session/request_permission',params:{toolCall:{kind:'execute'},options:[]}};send(normal);assert.deepEqual(await next(),normal);
  p.stdin.end(); await new Promise(r=>p.on('exit',r));
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('context reports only its own session usage and compact passes through', async () => {
 const dir = await mkdtemp(join(tmpdir(),'cc-bridge-'));
 try {
  const fake=join(dir,'fake'); await writeFile(fake,`#!/usr/bin/env node\nprocess.stdin.on('data',d=>process.stdout.write(d));\n`); await chmod(fake,0o755);
  const p=spawn(process.execPath,['acp-question-bridge/bridge.mjs'],{env:{...process.env,COMMAND_CODE_BINARY:fake},stdio:['pipe','pipe','inherit']});
  const queue=[]; let wake; createInterface({input:p.stdout}).on('line',l=>{queue.push(JSON.parse(l));wake?.()});
  const next=async()=>{while(!queue.length)await new Promise(r=>wake=r);wake=null;return queue.shift()};
  const send=x=>p.stdin.write(JSON.stringify(x)+'\n');
  const update=(sessionId,update)=>({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});
  send(update('a',{sessionUpdate:'available_commands_update',availableCommands:[{name:'compact'}]}));
  let result=await next();assert.deepEqual(result.params.update.availableCommands.map(x=>x.name),['compact','cccompact','context']);
  send(update('a',{sessionUpdate:'usage_update',used:180505,size:1000000}));await next();
  const prompt=(id,sessionId,text)=>({jsonrpc:'2.0',id,method:'session/prompt',params:{sessionId,prompt:[{type:'text',text}]}});
  send(prompt(20,'a','/context'));result=await next();assert.match(result.params.update.content.text,/180,505/);assert.match(result.params.update.content.text,/last reported/);assert.equal((await next()).result.stopReason,'end_turn');
  send(prompt(21,'b','/context'));assert.match((await next()).params.update.content.text,/No context usage/);await next();
  const alias=prompt(22,'a','/cccompact');send(alias);assert.deepEqual(await next(),prompt(22,'a','/compact'));
  const compact=prompt(24,'a','/compact');send(compact);assert.deepEqual(await next(),compact);
  send(update('a',{sessionUpdate:'available_commands_update',availableCommands:[{name:'context'}]}));await next();
  const native=prompt(23,'a','/context');send(native);assert.deepEqual(await next(),native);
  p.stdin.end();await new Promise(r=>p.on('exit',r));
 } finally {await rm(dir,{recursive:true,force:true})}
});
