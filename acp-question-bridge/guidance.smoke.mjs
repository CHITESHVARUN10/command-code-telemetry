// Opt-in: two real model turns in a fresh disposable Command Code session.
// Observe only whether the native system prompt contains the exact guidance,
// once, before and after /compact. Never save prompts, responses or credentials.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, chmod, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';

const bridge = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('./bridge.mjs',import.meta.url));
const guidance = new URL('./t3-guidance.mjs', pathToFileURL(bridge)).href;
const dir = await mkdtemp(join(tmpdir(),'cc-system-guidance-smoke-'));
const observer = join(dir,'observer.mjs'), wrapper = join(dir,'native.mjs'), checks = join(dir,'checks.ndjson');
await writeFile(observer, `
import {appendFileSync} from 'node:fs';
import {T3_GUIDANCE} from ${JSON.stringify(guidance)};
export default function(cmd) {
 cmd.hooks({transformSystemPrompt({system}) {
  appendFileSync(${JSON.stringify(checks)}, JSON.stringify({present:system.includes(T3_GUIDANCE),
    copies:system.split('<t3_bridge_guidance version="1">').length-1})+'\\n', {mode:0o600});
  return system;
 }});
}
`);
await writeFile(wrapper, `#!/usr/bin/env node
import {spawn} from 'node:child_process';
const child=spawn(${JSON.stringify(process.env.COMMAND_CODE_BINARY || '/usr/local/bin/cmd')},
 ['--mod',${JSON.stringify(observer)},...process.argv.slice(2)],{stdio:'inherit',env:process.env});
child.on('error',()=>{process.exitCode=1});
child.on('close',(code,signal)=>{process.exitCode=code || (signal ? 1 : 0)});
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>child.kill(signal));
`);
await chmod(wrapper,0o755);
const child=spawn(process.execPath,[bridge],{cwd:dir,stdio:['pipe','pipe','pipe'],env:{...process.env,
 COMMAND_CODE_BINARY:wrapper, COMMAND_CODE_BRIDGE_T3_GUIDANCE:'1', COMMAND_CODE_BRIDGE_IDLE_MS:'0',
 COMMAND_CODE_BRIDGE_LOG:'', COMMAND_CODE_BRIDGE_CRASH_DIR:''}});
let seq=0, sessionId, closed=false;
const pending=new Map();
child.stderr.resume(); // Native output may contain sensitive details; never echo it.
const completion=new Promise(resolve=>child.on('close',()=>{
 closed=true;
 for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('Native process closed'));}
 pending.clear();resolve();
}));
createInterface({input:child.stdout}).on('line',line=>{
 const m=JSON.parse(line), entry=pending.get(m.id);
 if(!entry)return;
 clearTimeout(entry.timer);pending.delete(m.id);
 if(m.error)entry.reject(new Error('Native request failed: JSON-RPC '+m.error.code));else entry.resolve(m.result);
});
const request=(method,params)=>new Promise((resolve,reject)=>{
 const id=++seq, timer=setTimeout(()=>{pending.delete(id);reject(new Error('Timed out: '+method));},60_000);
 pending.set(id,{resolve,reject,timer});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
});
try {
 const initialized=await request('initialize',{protocolVersion:2,clientInfo:{name:'bridge-guidance-smoke',version:'1'},clientCapabilities:{elicitation:{form:{}}}});
 ({sessionId}=await request('session/new',{cwd:dir,mcpServers:[]}));
 for(let i=0;i<2;i++) {
  const reply=await request('session/prompt',{sessionId,prompt:[{type:'text',text:'This is a disposable bridge system-guidance smoke test. Reply exactly READY. Do not use tools, create files, or ask questions.'}]});
  assert.equal(reply.stopReason,'end_turn');
  if(i===0)await request('session/prompt',{sessionId,prompt:[{type:'text',text:'/compact'}]});
 }
 const results=(await readFile(checks,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.ok(results.length>=2,'Native system prompt observer did not run for both turns');
 assert.ok(results.every(r=>r.present && r.copies===1),'System guidance missing or duplicated');
 await request('session/close',{sessionId});sessionId=undefined;
 console.log(JSON.stringify({ok:true,nativeVersion:initialized.agentInfo?.version,modelTurns:2,
  systemChecks:results.length,guidanceCopies:1,scope:'Native system append before and after /compact; no T3 UI acceptance test'}));
} finally {
 if(sessionId&&!closed)await request('session/close',{sessionId}).catch(()=>{});
 child.stdin.end();
 const kill=setTimeout(()=>child.kill('SIGKILL'),2_000);
 await completion;clearTimeout(kill);
 await rm(dir,{recursive:true,force:true});
}
