import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, chmod, rm, mkdir, readFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';

const rpc = (id, method, params) => ({jsonrpc:'2.0', ...(id === undefined ? {} : {id}), method, params});
const result = (id, value = {stopReason:'end_turn'}) => ({jsonrpc:'2.0', id, result:value});
const prompt = (id, sessionId, text) => rpc(id, 'session/prompt', {sessionId, prompt:[{type:'text', text}]});
const update = (sessionId, value) => rpc(undefined, 'session/update', {sessionId, update:value});
const q = (id, sessionId = 'a', plan = false) => {
  const labels = plan ? ['Yes, auto-accept edits', 'Cancel'] : ['A (Recommended)', 'B', 'C'];
  return rpc(id, 'session/request_permission', {sessionId,
    toolCall:{toolCallId:`tool-${id}`, kind:'other', title:plan ? 'Exit Plan' : 'Which?',
      rawInput:{question:plan ? 'Exit plan mode and begin implementation?' : 'Which?', options:labels}},
    options:labels.map((name, i) => ({optionId:`option_${i}`, kind:'allow_once', name}))});
};

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-bridge-'));
  const fake = join(dir, 'fake');
  await writeFile(fake, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
send({jsonrpc:'2.0', method:'test/ready'});
createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'test/emit') send(m.params);
 else if (m.method === 'test/invalid') process.stdout.write('not-json\\n');
 else if (m.method === 'test/exit') process.exit(7);
 else if (m.method === 'test/flood') {
  const data = JSON.stringify(m.params) + '\\n';
  process.stdout.end(data, () => process.exit(0));
 } else send({jsonrpc:'2.0', method:'test/received', params:m});
});
`);
  // An .mjs extension is required for Node 22's ESM executable fixture.
  const esmFake = fake + '.mjs';
  await writeFile(esmFake, await readFile(fake)); await chmod(esmFake, 0o755);
  const p = spawn(process.execPath, ['acp-question-bridge/bridge.mjs'], {
    env:{...process.env, HOME:dir, COMMAND_CODE_BINARY:esmFake, COMMAND_CODE_BRIDGE_LOG:join(dir, 'diagnostics.ndjson'),
      COMMAND_CODE_BRIDGE_IDLE_MS:'0', ...options}, stdio:['pipe','pipe','pipe']});
  let stderr = '', wake, closed = false;
  const queue = [];
  p.stderr.on('data', d => {stderr += d});
  const exit = new Promise(resolve => p.on('close', (code, signal) => {closed = true; wake?.(); resolve({code, signal});}));
  createInterface({input:p.stdout}).on('line', line => {queue.push(JSON.parse(line)); wake?.();});
  async function next() {
    const deadline = Date.now() + 4_000;
    while (!queue.length) {
      if (closed) throw new Error('Bridge closed: ' + stderr);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {wake = null; reject(new Error('Timed out waiting for bridge: ' + stderr));}, Math.max(1, deadline - Date.now()));
        wake = () => {clearTimeout(timer); wake = null; resolve()};
      });
    }
    return queue.shift();
  }
  const send = m => p.stdin.write(JSON.stringify(m) + '\n');
  const agent = m => send(rpc(undefined, 'test/emit', m));
  const received = async () => {const m = await next(); assert.equal(m.method, 'test/received'); return m.params;};
  t.after(async () => {
    if (!closed) {p.stdin.end(); const timer = setTimeout(() => p.kill('SIGKILL'), 500); await exit; clearTimeout(timer);}
    await rm(dir, {recursive:true, force:true});
  });
  assert.equal((await next()).method, 'test/ready');
  return {dir, p, send, agent, next, received, exit, stderr:() => stderr};
}

test('explicit non-recommended selection, custom/cancel, and normal permissions', {timeout:10_000}, async t => {
  const f = await fixture(t);
  for (const [id, action, answer, expected] of [[1,'accept','C','option_2'], [2,'accept','B','option_1'], [3,'accept','custom',null], [4,'cancel',null,null]]) {
    f.agent(q(id)); const form = await f.next();
    assert.equal(form.method, 'elicitation/create');
    assert.deepEqual(form.params.requestedSchema.properties.answer.enum, ['A (Recommended)','B','C']);
    f.send(result(form.id, {action, content:{answer}}));
    assert.deepEqual((await f.received()).result.outcome, expected ? {outcome:'selected', optionId:expected} : {outcome:'cancelled'});
  }
  const ordinary = rpc(20, 'session/request_permission', {sessionId:'a', toolCall:{kind:'execute'}, options:[]});
  f.agent(ordinary); assert.deepEqual(await f.next(), ordinary);
  f.send(result(20, {outcome:{outcome:'cancelled'}})); assert.equal((await f.received()).id, 20);
});

test('usage isolation, native command precedence, and compaction followed by thinking', {timeout:10_000}, async t => {
  const f = await fixture(t);
  f.agent(update('a', {sessionUpdate:'available_commands_update', availableCommands:[{name:'compact'}]}));
  assert.deepEqual((await f.next()).params.update.availableCommands.map(c => c.name), ['compact','context','cccompact','plan','ccplan','bridge-status']);
  f.agent(update('a', {sessionUpdate:'usage_update', used:180505, size:1000000})); await f.next();
  f.send(prompt(1,'a','/context')); assert.match((await f.next()).params.update.content.text, /180,505/); await f.next();
  f.send(prompt(2,'b','/context')); assert.match((await f.next()).params.update.content.text, /No context usage/); await f.next();
  f.send(prompt(3,'a','/cccompact')); assert.deepEqual(await f.received(), prompt(3,'a','/compact'));
  f.agent(update('a', {sessionUpdate:'usage_update', used:20000, size:1000000})); await f.next();
  f.agent(result(3)); assert.equal((await f.next()).id, 3);
  f.send(prompt(4,'a','continue')); assert.deepEqual(await f.received(), prompt(4,'a','continue'));
  const thought = update('a', {sessionUpdate:'agent_thought_chunk', content:{type:'text', text:'checking 🧠'}});
  f.agent(thought); assert.deepEqual(await f.next(), thought);
  f.agent(result(4)); await f.next();
  f.send(prompt(5,'a','/context')); assert.match((await f.next()).params.update.content.text, /20,000/); await f.next();
  f.agent(update('a', {sessionUpdate:'available_commands_update', availableCommands:[{name:'context'}, {name:'plan'}, {name:'cccompact'}]})); await f.next();
  f.send(prompt(6,'a','/context')); assert.deepEqual(await f.received(), prompt(6,'a','/context'));
  f.agent(result(6)); await f.next();
  f.send(prompt(7,'a','/plan task')); assert.deepEqual(await f.received(), prompt(7,'a','/plan task'));
});

test('cancelled questions cannot answer a later turn or another session', {timeout:10_000}, async t => {
  const f = await fixture(t);
  f.send(prompt(1,'a','task')); await f.received();
  f.agent(q(20,'a')); const form = await f.next();
  f.agent(q(21,'b')); const other = await f.next();
  const cancel = rpc(undefined, 'session/cancel', {sessionId:'a'});
  f.send(cancel); assert.deepEqual(await f.received(), cancel);
  assert.deepEqual((await f.received()).result.outcome, {outcome:'cancelled'});
  f.send(result(form.id, {action:'accept', content:{answer:'A (Recommended)'}}));
  f.send(result(other.id, {action:'accept', content:{answer:'C'}}));
  assert.equal((await f.received()).id, 21);
  f.agent(result(1, {stopReason:'cancelled'})); await f.next();
  f.send(prompt(2,'a','new task')); assert.equal((await f.received()).id, 2);
  f.agent(q(22,'a')); const next = await f.next(); assert.notEqual(next.id, form.id);
  f.send(result(next.id, {action:'accept', content:{answer:'B'}}));
  assert.deepEqual((await f.received()).result.outcome, {outcome:'selected', optionId:'option_1'});
});

test('native /plan mode is acknowledged before forwarding its task', {timeout:10_000}, async t => {
  const f = await fixture(t);
  f.send(prompt(1,'a','/plan investigate imports'));
  const mode = await f.received(); assert.equal(mode.method, 'session/set_mode'); assert.equal(mode.params.modeId, 'plan');
  f.agent(result(mode.id, {})); assert.equal((await f.next()).params.update.currentModeId, 'plan');
  assert.deepEqual(await f.received(), prompt(1,'a','investigate imports'));
  f.agent(result(1)); await f.next();
  f.send(prompt(2,'a','/ccplan'));
  const nextMode = await f.received(); f.agent(result(nextMode.id, {})); await f.next();
  assert.match((await f.next()).params.update.content.text, /Plan mode enabled/); assert.equal((await f.next()).id, 2);
});

test('mode failure or cancellation never starts the requested plan task', {timeout:10_000}, async t => {
  const f = await fixture(t);
  f.send(prompt(1,'a','/plan task')); const mode = await f.received();
  f.agent({jsonrpc:'2.0', id:mode.id, error:{code:-32602, message:'Mode unavailable'}});
  assert.deepEqual(await f.next(), {jsonrpc:'2.0', id:1, error:{code:-32602, message:'Mode unavailable'}});
  f.send(prompt(2,'a','/plan task')); const mode2 = await f.received();
  f.send(rpc(undefined, 'session/cancel', {sessionId:'a'})); await f.received();
  f.agent(result(mode2.id, {})); assert.deepEqual(await f.next(), result(2, {stopReason:'cancelled'}));
});

async function beginPlan(f, text = '# My plan\n\nUpdate the imports.') {
  const path = join(f.dir, '.commandcode/plans/test.md');
  await mkdir(join(f.dir, '.commandcode/plans'), {recursive:true}); await writeFile(path, text);
  f.send(rpc(90, 'initialize', {clientInfo:{name:'t3-code'}, clientCapabilities:{elicitation:{form:{}}}})); await f.received();
  f.agent(result(90, {})); await f.next();
  f.send(prompt(1,'a','plan task')); await f.received();
  f.agent(update('a', {sessionUpdate:'tool_call', toolCallId:'write', kind:'edit', status:'pending', title:'WRITE', rawInput:{file_path:path, content:text}})); await f.next();
  f.agent(update('a', {sessionUpdate:'tool_call_update', toolCallId:'write', status:'completed'})); await f.next();
  return {path, text};
}

test('plan markdown renders before approval; changed plans require a new approval', {timeout:10_000}, async t => {
  const f = await fixture(t); const {path, text} = await beginPlan(f);
  f.agent(q(20,'a',true));
  const plan = await f.next(); assert.equal(plan.params.update.sessionUpdate, 'plan_update'); assert.equal(plan.params.update.plan.content, text);
  const form = await f.next(); assert.equal(form.method, 'elicitation/create');
  await writeFile(path, '# Updated plan');
  f.send(result(form.id, {action:'accept', content:{answer:'Implement this plan'}}));
  assert.match((await f.next()).params.update.content.text, /changed/);
  assert.equal((await f.next()).params.update.plan.content, '# Updated plan');
  const revised = await f.next();
  f.send(result(revised.id, {action:'accept', content:{answer:'Implement this plan'}}));
  assert.deepEqual((await f.received()).result.outcome, {outcome:'selected', optionId:'option_0'});
});

test('plan custom feedback cancels approval and reaches the next native prompt verbatim', {timeout:10_000}, async t => {
  const f = await fixture(t); await beginPlan(f);
  f.agent(q(20,'a',true)); await f.next(); const form = await f.next();
  const feedback = 'Keep the existing API.\nAdd regression coverage for π.';
  f.send(result(form.id, {action:'accept', content:{answer:feedback}}));
  assert.deepEqual((await f.received()).result.outcome, {outcome:'cancelled'});
  f.agent(result(1)); assert.match((await f.next()).params.update.content.text, /requested changes/);
  const revision = await f.received(); assert.equal(revision.id, 1); assert.ok(revision.params.prompt[0].text.includes(feedback));
  f.agent(result(1)); assert.equal((await f.next()).id, 1);
});

test('missing, other-session, and symlinked external plans cannot be approved', {timeout:10_000}, async t => {
  const f = await fixture(t); const {path} = await beginPlan(f);
  f.agent(q(20,'b',true)); assert.match((await f.next()).params.update.content.text, /could not identify/);
  let form = await f.next();
  f.send(result(form.id, {action:'accept', content:{answer:'Implement this plan'}}));
  assert.deepEqual((await f.received()).result.outcome, {outcome:'cancelled'});
  await rm(path); const outside = join(f.dir, 'outside.md'); await writeFile(outside, '# Private external file'); await symlink(outside, path);
  f.agent(q(21,'a',true)); assert.match((await f.next()).params.update.content.text, /could not identify/); form = await f.next();
  f.send(result(form.id, {action:'accept', content:{answer:form.params.requestedSchema.properties.answer.enum[0]}}));
  assert.deepEqual((await f.received()).result.outcome, {outcome:'cancelled'});
});

test('native failure discards submitted plan feedback rather than replaying the task', {timeout:10_000}, async t => {
  const f = await fixture(t); await beginPlan(f);
  f.agent(q(20,'a',true)); await f.next(); const form = await f.next();
  f.send(result(form.id, {action:'accept', content:{answer:'Revise the error handling.'}})); await f.received();
  const failure = {jsonrpc:'2.0', id:1, error:{code:-32603, message:'Native run failed'}};
  f.agent(failure); assert.deepEqual(await f.next(), failure);
  f.send(prompt(2,'a','new task')); assert.deepEqual(await f.received(), prompt(2,'a','new task'));
});

test('session teardown cancels its unanswered forms and ignores their late answers', {timeout:10_000}, async t => {
  const f = await fixture(t);
  f.agent(q(20)); const form = await f.next();
  f.send(rpc(1,'session/close',{sessionId:'a'}));
  assert.deepEqual((await f.received()).result.outcome, {outcome:'cancelled'});
  assert.equal((await f.received()).method, 'session/close');
  f.agent(result(1,{})); await f.next();
  f.send(result(form.id, {action:'accept', content:{answer:'B'}}));
  f.send(prompt(2,'b','task')); assert.deepEqual(await f.received(), prompt(2,'b','task'));
});

test('unsupported forms cancel the question instead of choosing a default', {timeout:10_000}, async t => {
  const f = await fixture(t);
  f.send(rpc(1, 'initialize', {clientCapabilities:{}})); await f.received(); f.agent(result(1, {})); await f.next();
  f.agent(q(2)); const responses = [await f.next(), await f.next()];
  assert.deepEqual(responses.find(m => m.method === 'test/received').params.result.outcome, {outcome:'cancelled'});
  assert.match(responses.find(m => m.method === 'session/update').params.update.content.text, /does not advertise question forms/);
});

test('silent post-compaction turn is cancelled and an unresponsive child fails visibly', {timeout:10_000}, async t => {
  const f = await fixture(t, {COMMAND_CODE_BRIDGE_IDLE_MS:'100', COMMAND_CODE_BRIDGE_CANCEL_MS:'100'});
  f.send(prompt(1,'a','/cccompact')); await f.received(); f.agent(result(1)); await f.next();
  f.send(prompt(2,'a','continue')); await f.received();
  assert.match((await f.next()).params.update.content.text, /silence limit/);
  assert.equal((await f.received()).method, 'session/cancel');
  const failure = await f.next(); assert.equal(failure.id, 2); assert.match(failure.error.message, /did not finish after cancellation/);
  assert.notEqual((await f.exit).code, 0);
  const diagnostics = await readFile(join(f.dir, 'diagnostics.ndjson'), 'utf8');
  assert.match(diagnostics, /silence_timeout/); assert.ok(!diagnostics.includes('continue'));
});

test('waiting for a user and active thinking do not trigger a silence timeout', {timeout:10_000}, async t => {
  const f = await fixture(t, {COMMAND_CODE_BRIDGE_IDLE_MS:'100'});
  f.send(prompt(1,'a','task')); await f.received(); f.agent(q(20)); const form = await f.next();
  await new Promise(resolve => setTimeout(resolve, 220));
  f.send(result(form.id, {action:'accept', content:{answer:'B'}})); assert.equal((await f.received()).id, 20);
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const thought = update('a', {sessionUpdate:'agent_thought_chunk', content:{type:'text', text:'thinking'}});
    f.agent(thought); assert.deepEqual(await f.next(), thought);
  }
  f.agent(result(1)); assert.equal((await f.next()).id, 1);
});

test('child exit and malformed output settle pending prompts as errors', {timeout:10_000}, async t => {
  for (const method of ['test/exit','test/invalid']) {
    const f = await fixture(t); f.send(prompt(1,'a','task')); await f.received(); f.send(rpc(undefined, method, {}));
    const error = await f.next(); assert.equal(error.id, 1); assert.ok(error.error); assert.notEqual((await f.exit).code, 0);
  }
});

test('large final thinking frame is drained fully even with a slow ACP reader', {timeout:10_000}, async t => {
  const f = await fixture(t);
  const large = update('a', {sessionUpdate:'agent_thought_chunk', content:{type:'text', text:'🧠'.repeat(700_000)}});
  f.p.stdout.pause(); f.send(rpc(undefined, 'test/flood', large));
  await new Promise(resolve => setTimeout(resolve, 150)); f.p.stdout.resume();
  assert.deepEqual(await f.next(), large); assert.equal((await f.exit).code, 0);
});
