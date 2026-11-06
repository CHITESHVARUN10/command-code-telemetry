#!/usr/bin/env node
// Proxy the real Command Code ACP process. Only submitted answers authorize a choice.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID, createHash} from 'node:crypto';
import {appendFileSync, mkdirSync, statSync, renameSync, realpathSync, openSync, readFileSync, closeSync, fstatSync, writeFileSync, readdirSync, unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, dirname, resolve, relative, isAbsolute} from 'node:path';

const executable = process.env.COMMAND_CODE_BINARY || '/usr/local/bin/cmd';
const VERSION = '2.0.3';
const numberOption = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 0 && process.env[key] !== '' ? value : fallback;
};
// ACP has no mandatory heartbeat. Silence alone cannot establish a dead turn:
// tools, model requests, and a sleeping host can all produce long quiet periods.
// Keep cancellation opt-in; transport failures and explicit Stop still work.
const idleMs = numberOption('COMMAND_CODE_BRIDGE_IDLE_MS', 0);
const cancelMs = numberOption('COMMAND_CODE_BRIDGE_CANCEL_MS', 5_000);
const logPath = process.env.COMMAND_CODE_BRIDGE_LOG ?? join(homedir(), '.commandcode/acp-question-bridge/diagnostics.ndjson');
function log(event, fields = {}) {
  // Never record prompts, answers, plan content, credentials, or child stderr.
  if (!logPath) return;
  try {
    mkdirSync(dirname(logPath), {recursive:true, mode:0o700});
    try { if (statSync(logPath).size > 1_048_576) renameSync(logPath, logPath + '.1'); } catch {}
    appendFileSync(logPath, JSON.stringify({at:new Date().toISOString(), pid:process.pid, version:VERSION, event, ...fields}) + '\n', {mode:0o600});
  } catch { /* Diagnostics must not break the transport. */ }
}

const child = spawn(executable, ['acp'], {stdio:['pipe','pipe','inherit'], env:process.env});
const pending = new Map();
const requests = new Map();
const controls = new Map();
const agentRequests = new Map();
const sessions = new Map();
const prefix = `cc-bridge-${randomUUID()}-`;
let seq = 0, stopping = false, clientEnded = false, finishTimer, lastProgress = Date.now();
let formSupport = true, planSupport = false;
const counters = {fromAgent:0, fromClient:0, thoughts:0, backpressure:0};
const blocked = new WeakSet();
const crashDir = process.env.COMMAND_CODE_BRIDGE_CRASH_DIR ?? join(homedir(), '.commandcode/acp-question-bridge/crashes');
const startedAt = Date.now(), flight = [];
let fatalReport, childExit = null, lastTick = Date.now(), maxTickGapMs = 0, nativeVersion = null;
const methods = new Set(['initialize','authenticate','session/new','session/load','session/resume','session/list','session/fork','session/close','session/prompt','session/cancel','session/set_mode','session/set_model','session/set_config_option','session/update','session/request_permission','elicitation/create']);
const updates = new Set(['agent_message_chunk','agent_thought_chunk','user_message_chunk','tool_call','tool_call_update','usage_update','available_commands_update','plan','plan_update','current_mode_update','config_option_update','session_info_update']);
const safeMethod = value => methods.has(value) ? value : 'extension';
const alias = value => value === undefined ? null : createHash('sha256').update(prefix + JSON.stringify(value)).digest('hex').slice(0, 16);
function trace(direction, value, chars) {
  // A bounded in-memory flight recorder. Never retain wire payloads or titles.
  const u = value?.params?.update;
  const event = {at:new Date().toISOString(), direction, method:value?.method ? safeMethod(value.method) : 'response',
    request:alias(value?.id), session:alias(value?.params?.sessionId), chars,
    ...(u ? {update:updates.has(u.sessionUpdate) ? u.sessionUpdate : 'extension', tool:alias(u.toolCallId),
      status:['pending','in_progress','completed','failed'].includes(u.status) ? u.status : undefined} : {}),
    ...(Number.isFinite(value?.error?.code) ? {errorCode:value.error.code} : {})};
  flight.push(event); if (flight.length > 96) flight.shift();
}
function failureReport(reason, error, fatal = false) {
  if (!crashDir || fatal && fatalReport) return;
  try {
    const now = Date.now();
    const report = {schemaVersion:1, at:new Date(now).toISOString(), reason, bridgeVersion:VERSION, nativeVersion,
      pid:process.pid, childPid:child.pid ?? null, childExit, runtime:{node:process.version, platform:process.platform, arch:process.arch,
        uptimeMs:now - startedAt, memory:process.memoryUsage()},
      policy:{idleMs, cancelMs}, state:{stopping, clientEnded, pendingQuestions:pending.size, nativeRequests:agentRequests.size,
        modeChanges:controls.size, maxTickGapMs, stdoutBufferedBytes:process.stdout.writableLength, childInputBufferedBytes:child.stdin.writableLength,
        clientOutputNeedsDrain:process.stdout.writableNeedDrain, nativeInputNeedsDrain:child.stdin.writableNeedDrain},
      systemErrorCode:['ENOENT','EACCES','EPIPE','ECONNRESET','ENOSPC','EMFILE'].includes(error?.code) ? error.code : null,
      counters:{...counters}, requests:[...requests.entries()].slice(0,32).map(([id,r]) => ({request:alias(id), session:alias(r.sessionId),
        method:safeMethod(r.method), silentMs:now-r.lastActivity, cancelling:Boolean(r.cancelAt), hasRevisionFeedback:Boolean(r.feedback)})),
      requestCount:requests.size, activeTools:[...sessions.entries()].flatMap(([session,s])=>[...s.tools.entries()].slice(0,32).map(([id,t])=>({session:alias(session), tool:alias(id),
        kind:['read','edit','delete','move','search','execute','think','fetch','other'].includes(t.kind) ? t.kind : 'other',
        status:['pending','in_progress','completed','failed'].includes(t.status) ? t.status : 'unknown'}))).slice(0,32), recentEvents:[...flight],
      // Own call-site frames locate bridge bugs without copying error messages,
      // native stderr, file paths supplied by users, or potentially secret text.
      bridgeFrames:[...String((error instanceof Error ? error : new Error()).stack ?? '').matchAll(/bridge\.mjs:\d+:\d+/g)].map(m=>m[0]).slice(0,12)};
    mkdirSync(crashDir, {recursive:true, mode:0o700});
    const path = join(crashDir, `crash-${now}-${process.pid}-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify(report,null,2)+'\n', {mode:0o600, flag:'wx'});
    if (fatal) fatalReport = {path, report};
    // Retain ten reports; prune only this recorder's names, never other files.
    const files = readdirSync(crashDir).filter(n=>/^crash-\d+-\d+-[a-f0-9-]+\.json$/.test(n)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1]));
    for (const name of files.slice(10)) try { unlinkSync(join(crashDir,name)); } catch {}
    try { process.stderr.write(`Command Code bridge failure report: ${path}\n`); } catch {}
  } catch { /* An unavailable report directory must not alter ACP behavior. */ }
}
function finishFailureReport() {
  if (!fatalReport) return;
  try { writeFileSync(fatalReport.path, JSON.stringify({...fatalReport.report, childExit},null,2)+'\n', {mode:0o600}); } catch {}
}
const clientLines = createInterface({input:process.stdin, crlfDelay:Infinity});
const agentLines = createInterface({input:child.stdout, crlfDelay:Infinity});
const state = id => {
  if (!sessions.has(id)) sessions.set(id, {usage:null, native:new Set(), plan:null, tools:new Map()});
  return sessions.get(id);
};
const update = (sessionId, value) => ({jsonrpc:'2.0', method:'session/update', params:{sessionId, update:value}});
const message = (sessionId, text) => sendClient(update(sessionId, {sessionUpdate:'agent_message_chunk', content:{type:'text', text}}));
const errorResult = (id, text) => ({jsonrpc:'2.0', id, error:{code:-32603, message:text}});

function write(stream, value, source) {
  if (stream.destroyed || stream.writableEnded) throw new Error('ACP output is closed');
  const line = JSON.stringify(value) + '\n';
  trace(stream === process.stdout ? 'to_client' : 'to_native', value, line.length);
  if (!stream.write(line)) {
    counters.backpressure++;
    source.pause();
    if (!blocked.has(stream)) {
      blocked.add(stream);
      stream.once('drain', () => { blocked.delete(stream); if (!stopping) source.resume(); });
    }
  }
}
function sendClient(value) { write(process.stdout, value, agentLines); }
function sendAgent(value) { write(child.stdin, value, clientLines); }
function armTermination() {
  if (finishTimer) return;
  finishTimer = setTimeout(() => child.kill('SIGKILL'), cancelMs || 5_000);
  finishTimer.unref();
}
function fail(reason, error) {
  if (stopping) return;
  failureReport(reason, error, true);
  stopping = true;
  log('transport_failure', {reason, ...counters, outstanding:requests.size, questions:pending.size});
  process.stderr.write(`Command Code bridge: ${reason}\n`);
  // Settle all original client requests, including setup and compaction, before closing.
  for (const id of requests.keys()) {
    try { sendClient(errorResult(id, reason + ' Reconnect the provider; this bridge has not retried your task.')); } catch {}
  }
  requests.clear(); controls.clear(); pending.clear(); agentRequests.clear();
  clientLines.close(); process.stdin.destroy();
  child.kill('SIGTERM');
  armTermination();
  process.exitCode = 1;
}
function parse(line, direction) {
  if (!line.trim()) return null;
  const fromClient = direction === 'ACP client';
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    if (fromClient) clientProtocolError(-32700, 'Parse error: invalid JSON', 'invalid_json', line.length);
    else { trace('invalid_native_frame', {}, line.length); fail('Invalid JSON-RPC from Command Code; the connection was closed instead of dropping a message.'); }
    return null;
  }
  if (!fromClient && (!value || typeof value !== 'object' || Array.isArray(value))) {
    fail('Invalid JSON-RPC from Command Code; expected an object.');
    return null;
  }
  // T3's Effect JSON-RPC codec can encode batches. Expand them into individual
  // frames because Command Code accepts only one object per line.
  if (fromClient) return {messages:Array.isArray(value) && value.length ? value : [value]};
  return value;
}
function clientProtocolError(code, message, category, chars) {
  log('client_protocol_error', {category, chars});
  sendClient({jsonrpc:'2.0', id:null, error:{code, message}});
}
function validClientMessage(value) {
  const object = value && typeof value === 'object' && !Array.isArray(value);
  const hasId = object && Object.hasOwn(value, 'id');
  const validId = !hasId || value.id === null || typeof value.id === 'string' || (typeof value.id === 'number' && Number.isFinite(value.id));
  const request = object && typeof value.method === 'string';
  const response = object && !Object.hasOwn(value, 'method') && hasId && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'));
  return object && value.jsonrpc === '2.0' && validId && (request || response);
}
function active(sessionId) {
  return [...requests.values()].find(r => r.method === 'session/prompt' && r.sessionId === sessionId);
}
function touch(sessionId) {
  for (const request of requests.values()) if (request.sessionId === sessionId) request.lastActivity = Date.now();
}
function clearQuestions(sessionId) {
  for (const [id, entry] of pending) {
    if (entry.sessionId !== sessionId) continue;
    pending.delete(id);
    sendAgent({jsonrpc:'2.0', id:entry.originalId, result:{outcome:{outcome:'cancelled'}}});
  }
  for (const [id, entry] of agentRequests) if (entry.sessionId === sessionId) agentRequests.delete(id);
}
function cancel(sessionId) {
  sendAgent({jsonrpc:'2.0', method:'session/cancel', params:{sessionId}});
  clearQuestions(sessionId);
  const request = active(sessionId);
  if (request) { request.cancelAt = Date.now(); request.feedback = undefined; }
}
function question(params) {
  const call = params?.toolCall, raw = call?.rawInput, options = params?.options;
  if (call?.kind !== 'other' || !raw || typeof raw.question !== 'string') return null;
  const labels = raw.options;
  if (!Array.isArray(labels) || labels.length < 2 || labels.length > 4 || !Array.isArray(options) || options.length !== labels.length ||
      labels.some(x => typeof x !== 'string' || !x.trim()) || new Set(labels).size !== labels.length ||
      options.some((o, i) => o.kind !== 'allow_once' || o.optionId !== `option_${i}` ||
        typeof o.name !== 'string' || !(o.name === labels[i] || o.name.startsWith(`${labels[i]}: `)))) return false;
  const isPlan = /^(?:Exit plan mode and begin implementation\?|Plan ready for review\. Begin implementation\?)$/.test(raw.question) &&
    labels.length === 2 && labels[0] === 'Yes, auto-accept edits' && labels[1] === 'Cancel';
  return {labels, options, call, isPlan};
}

const plansRoot = resolve(homedir(), '.commandcode/plans');
const within = (root, file) => { const part = relative(root, file); return part !== '' && part !== '..' && !part.startsWith('../') && !isAbsolute(part); };
function planFile(path) {
  // Never scan the global directory for "latest": another session may own that plan.
  if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('.md') || !within(plansRoot, resolve(path))) return null;
  let fd;
  try {
    const file = realpathSync(path), root = realpathSync(plansRoot);
    if (!within(root, file)) return null;
    fd = openSync(file, 'r');
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 1_048_576) return null;
    const text = readFileSync(fd, 'utf8');
    return text.trim() ? {text, path, hash:createHash('sha256').update(text).digest('hex')} : null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
function observeTool(sessionId, tool) {
  if (!active(sessionId)) return; // Do not adopt a plan from replayed history.
  const s = state(sessionId), id = tool.toolCallId;
  if (!id) return;
  const prior = s.tools.get(id) ?? {};
  const merged = {...prior, ...tool};
  if (tool.sessionUpdate === 'tool_call_update') merged.sessionUpdate = prior.sessionUpdate;
  s.tools.set(id, merged);
  const input = merged.rawInput;
  if (merged.status === 'failed') { s.tools.delete(id); return; }
  if (input && merged.kind === 'edit' && typeof input.file_path === 'string' &&
      within(plansRoot, resolve(input.file_path))) s.plan = {path:input.file_path};
  if (input && /^(?:exit_plan_mode|PLAN\(exit\))$/.test(merged.title ?? '') && typeof input.plan === 'string') {
    // Native exit_plan_mode prefers a plan file to its fallback argument, as do we.
    if (!s.plan?.path) s.plan = {text:input.plan};
  }
  if (merged.status === 'completed') s.tools.delete(id);
}
function reviewPlan(sessionId, q) {
  if (typeof q.call.rawInput.planContent === 'string' && q.call.rawInput.planContent.trim()) return {text:q.call.rawInput.planContent};
  const plan = state(sessionId).plan;
  return plan?.path ? planFile(plan.path) : plan?.text?.trim() ? plan : null;
}
function ask(originalId, sessionId, q) {
  if (!formSupport) {
    sendAgent({jsonrpc:'2.0', id:originalId, result:{outcome:{outcome:'cancelled'}}});
    message(sessionId, 'This ACP client does not advertise question forms. The bridge cancelled the question without selecting an answer.');
    return;
  }
  const plan = q.isPlan ? reviewPlan(sessionId, q) : null;
  let labels = q.labels, description = q.call.rawInput.question;
  if (q.isPlan) {
    labels = plan ? ['Implement this plan', 'Stop — review or revise in chat'] : ['Stop — plan content unavailable'];
    description = plan ? 'Review the plan above. Choose Implement to approve, choose Stop, or enter your requested changes as a custom answer. Custom text requests revision and never approves implementation.' : 'The bridge could not identify this session’s plan. Implementation cannot be approved here. Ask the agent to write the plan and present it again.';
    if (plan) {
      if (planSupport) sendClient(update(sessionId, {sessionUpdate:'plan_update', plan:{type:'markdown', planId:`${prefix}plan-${sessionId}`, content:plan.text}}));
      else message(sessionId, `Plan for review${plan.path ? ` (${plan.path})` : ''}:\n\n${plan.text}`);
    } else message(sessionId, description);
  }
  const id = prefix + ++seq;
  pending.set(id, {originalId, sessionId, q, labels, plan});
  sendClient({jsonrpc:'2.0', id, method:'elicitation/create', params:{mode:'form', sessionId,
    message:q.call.title || q.call.rawInput.question,
    requestedSchema:{type:'object', properties:{answer:{type:'string', title:q.isPlan ? 'Plan review' : 'Select one option', description, enum:labels}}, required:['answer']}}});
  log('question_opened', {plan:q.isPlan, choices:labels.length});
}
function answered(id, m) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  const answer = m.result?.action === 'accept' ? m.result?.content?.answer : undefined;
  let index = typeof answer === 'string' ? entry.labels.indexOf(answer) : -1;
  if (entry.q.isPlan) {
    if (index === 0 && entry.plan) {
      if (entry.plan.path && planFile(entry.plan.path)?.hash !== entry.plan.hash) {
        message(entry.sessionId, 'The plan changed after it was displayed. Review the updated plan before approving.');
        ask(entry.originalId, entry.sessionId, entry.q);
        return;
      }
      index = 0;
    } else {
      if (entry.plan && index < 0 && typeof answer === 'string' && answer.trim() && active(entry.sessionId)) {
        active(entry.sessionId).feedback = answer;
      }
      index = -1;
    }
  }
  touch(entry.sessionId);
  sendAgent({jsonrpc:'2.0', id:entry.originalId, result:{outcome:index >= 0 ? {outcome:'selected', optionId:entry.q.options[index].optionId} : {outcome:'cancelled'}}});
  log('question_closed', {plan:entry.q.isPlan, selected:index >= 0, feedback:Boolean(active(entry.sessionId)?.feedback)});
}

function agentMessage(m) {
  counters.fromAgent++;
  if (m.method === 'session/update') {
    const sessionId = m.params?.sessionId, u = m.params?.update;
    if (typeof sessionId === 'string' && u) {
      touch(sessionId);
      const s = state(sessionId);
      if (u.sessionUpdate === 'agent_thought_chunk') counters.thoughts++;
      if (u.sessionUpdate === 'usage_update' && Number.isFinite(u.used) && u.used >= 0 && Number.isFinite(u.size) && u.size > 0) s.usage = {used:u.used, size:u.size};
      if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') observeTool(sessionId, u);
      if (u.sessionUpdate === 'available_commands_update' && Array.isArray(u.availableCommands)) {
        s.native = new Set(u.availableCommands.map(c => c.name));
        for (const [name, description, input] of [
          ['context', 'Show the last context usage reported by Command Code', null],
          ['cccompact', 'Compact this Command Code session', null],
          ['plan', 'Enter native plan mode; optional task', {hint:'task (optional)'}],
          ['ccplan', 'Enter native plan mode; optional task', {hint:'task (optional)'}],
          ['bridge-status', 'Show bridge transport status', null],
        ]) if (!s.native.has(name)) u.availableCommands.push({name, description, input});
      }
    }
  }
  if (m.id !== undefined && !m.method) {
    if (controls.has(m.id)) {
      const {clientId, task, original} = controls.get(m.id);
      controls.delete(m.id);
      if (m.error) { requests.delete(clientId); sendClient({...m, id:clientId}); return; }
      const sessionId = original.params.sessionId;
      if (requests.get(clientId)?.cancelAt) {
        requests.delete(clientId);
        sendClient({jsonrpc:'2.0', id:clientId, result:{stopReason:'cancelled'}});
        return;
      }
      sendClient(update(sessionId, {sessionUpdate:'current_mode_update', currentModeId:'plan'}));
      if (!task) {
        requests.delete(clientId);
        message(sessionId, 'Plan mode enabled. Send the task to plan; implementation requires your approval.');
        sendClient({jsonrpc:'2.0', id:clientId, result:{stopReason:'end_turn'}});
      } else sendAgent({...original, params:{...original.params, prompt:[{type:'text', text:task}]}});
      return;
    }
    const request = requests.get(m.id);
    if (request?.method === 'initialize' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(m.result?.agentInfo?.version ?? '')) nativeVersion = m.result.agentInfo.version;
    if (request && m.error) failureReport('native_request_error');
    if (request?.method === 'session/prompt') {
      clearQuestions(request.sessionId);
      state(request.sessionId).tools.clear();
      if (request.feedback && !m.error && !request.cancelAt && m.result?.stopReason === 'end_turn') {
        const feedback = request.feedback;
        request.feedback = undefined; request.lastActivity = Date.now();
        message(request.sessionId, 'Your requested changes were submitted. Revising the plan; implementation still requires approval.');
        sendAgent({jsonrpc:'2.0', id:m.id, method:'session/prompt', params:{sessionId:request.sessionId, prompt:[{type:'text', text:`The user submitted this plan-review feedback:\n\n${feedback}\n\nRevise the plan to address this feedback and present it for review again. Do not implement until the user explicitly approves.`}]}});
        return;
      }
      log('prompt_completed', {...counters, failed:Boolean(m.error), stopReason:m.result?.stopReason});
    }
    if (request?.method === 'session/close' && !m.error) sessions.delete(request.sessionId);
    requests.delete(m.id);
  }
  if (m.method === 'session/request_permission' && m.id !== undefined) {
    const q = question(m.params);
    if (q === false) { sendAgent({jsonrpc:'2.0', id:m.id, result:{outcome:{outcome:'cancelled'}}}); log('unsupported_question'); return; }
    if (q) { ask(m.id, m.params.sessionId, q); return; }
  }
  if (m.method && m.id !== undefined) agentRequests.set(m.id, {sessionId:m.params?.sessionId});
  sendClient(m);
}
function clientMessage(m) {
  counters.fromClient++;
  if (m.id !== undefined && !m.method) {
    if (pending.has(m.id)) { answered(m.id, m); return; }
    if (typeof m.id === 'string' && m.id.startsWith(prefix)) { log('late_answer_ignored'); return; }
    const entry = agentRequests.get(m.id);
    if (entry) touch(entry.sessionId);
    agentRequests.delete(m.id);
    sendAgent(m); return;
  }
  if (m.method === 'initialize') {
    formSupport = m.params?.clientCapabilities?.elicitation?.form != null;
    // The installed T3 supports draft markdown plans but does not advertise plan:{}.
    planSupport = m.params?.clientCapabilities?.plan != null || m.params?.clientInfo?.name === 't3-code';
  }
  const sessionId = m.params?.sessionId;
  if (m.method === 'session/prompt' && m.id !== undefined) {
    if (active(sessionId)) { sendClient({jsonrpc:'2.0', id:m.id, error:{code:-32600, message:'A prompt is already running for this session. Stop it before starting another.'}}); return; }
    const prompt = m.params?.prompt;
    const text = Array.isArray(prompt) && prompt.length === 1 && prompt[0]?.type === 'text' && typeof prompt[0].text === 'string' ? prompt[0].text.trim() : '';
    const s = state(sessionId);
    if (text === '/context' && !s.native.has('context')) {
      const r = s.usage;
      message(sessionId, r ? `Context (last reported by Command Code)\n\nUsed: ${Math.round(r.used).toLocaleString()} tokens\nWindow: ${Math.round(r.size).toLocaleString()} tokens\nFree: ${Math.max(0, Math.round(r.size - r.used)).toLocaleString()} tokens\nFill: ${Math.min(100, Math.max(0, Math.round(r.used / r.size * 100)))}%\n\nThis is an ACP host reading, not the terminal /context analysis. It may be an estimate and may not immediately reflect compaction.` : 'No context usage has been reported for this session yet. Send a model request and try again.');
      sendClient({jsonrpc:'2.0', id:m.id, result:{stopReason:'end_turn'}}); return;
    }
    if (text === '/bridge-status' && !s.native.has('bridge-status')) {
      message(sessionId, `Command Code bridge ${VERSION}\nAgent messages: ${counters.fromAgent}\nThinking chunks forwarded: ${counters.thoughts}\nPending questions: ${pending.size}\nSilence limit: ${idleMs ? `${idleMs / 1000}s` : 'disabled'}\nFailure reports: ${crashDir || 'disabled'}\nNo tasks are automatically retried.`);
      sendClient({jsonrpc:'2.0', id:m.id, result:{stopReason:'end_turn'}}); return;
    }
    if (text === '/cccompact' && !s.native.has('cccompact')) m = {...m, params:{...m.params, prompt:[{...prompt[0], text:'/compact'}]}};
    requests.set(m.id, {method:m.method, sessionId, lastActivity:Date.now()});
    const plan = /^\/(plan|ccplan)(?:\s+([\s\S]*))?$/.exec(text);
    if (plan && !s.native.has(plan[1])) {
      const id = prefix + 'mode-' + ++seq;
      controls.set(id, {clientId:m.id, original:m, task:plan[2]?.trim()});
      sendAgent({jsonrpc:'2.0', id, method:'session/set_mode', params:{sessionId, modeId:'plan'}}); return;
    }
    log('prompt_started', {compaction:text === '/cccompact' || text === '/compact'});
  } else if (m.method && m.id !== undefined) requests.set(m.id, {method:m.method, sessionId, lastActivity:Date.now()});
  if (m.method === 'session/cancel') {
    // Forward cancellation first so resolving an old question cannot resume the run.
    sendAgent(m); clearQuestions(sessionId);
    const request = active(sessionId);
    if (request) { request.cancelAt = Date.now(); request.feedback = undefined; }
    return;
  }
  if (m.method === 'session/close') { clearQuestions(sessionId); }
  sendAgent(m);
}

agentLines.on('line', line => {
  if (stopping) return;
  const m = parse(line, 'Command Code');
  if (m) try { trace('from_native', m, line.length); agentMessage(m); } catch (error) { fail('Failed to forward a Command Code message.', error); }
});
clientLines.on('line', line => {
  if (stopping) return;
  const frame = parse(line, 'ACP client');
  if (!frame) return;
  for (const m of frame.messages) {
    if (stopping) break;
    if (!validClientMessage(m)) {
      clientProtocolError(-32600, 'Invalid Request: expected a JSON-RPC 2.0 message', 'invalid_message', line.length);
      continue;
    }
    try { trace('from_client', m, line.length); clientMessage(m); } catch (error) { fail('Failed to forward an ACP client message.', error); }
  }
});
const watchdog = setInterval(() => {
  if (stopping) return;
  const now = Date.now();
  maxTickGapMs = Math.max(maxTickGapMs, now-lastTick); lastTick = now;
  if (requests.size && now - lastProgress >= 60_000) {
    log('progress', {...counters, requests:requests.size, questions:pending.size,
      silentMs:Math.max(...[...requests.values()].map(r => now - r.lastActivity))});
    lastProgress = now;
  }
  for (const r of requests.values()) {
    if (r.cancelAt && now - r.cancelAt >= cancelMs) { fail('Command Code did not finish after cancellation.'); return; }
    const waiting = [...pending.values(), ...agentRequests.values()].some(q => q.sessionId === r.sessionId);
    if (idleMs && !r.cancelAt && !waiting && now - r.lastActivity >= idleMs) {
      failureReport('opt_in_silence_timeout');
      log('silence_timeout', {method:r.method, ...counters});
      if (r.method === 'session/prompt' && ![...controls.values()].some(control => requests.get(control.clientId) === r)) {
        message(r.sessionId, 'Command Code has not sent ACP activity within the configured silence limit. Cancelling this turn; no task will be retried automatically.');
        cancel(r.sessionId);
      } else fail('Command Code did not respond within the configured silence limit.');
      return;
    }
  }
}, Math.max(20, Math.min(1_000, idleMs || 1_000, cancelMs || 1_000)));
watchdog.unref();
process.stdin.on('end', () => {
  clientEnded = true;
  for (const r of requests.values()) if (r.method === 'session/prompt') cancel(r.sessionId);
  child.stdin.end(); armTermination();
});
process.stdin.on('error', error => fail('ACP client input disconnected.', error));
process.stdout.on('error', error => fail('ACP client output disconnected.', error));
child.stdin.on('error', error => fail('Command Code input pipe closed.', error));
child.stdout.on('error', error => fail('Command Code output pipe closed.', error));
child.on('error', error => fail('Could not start the configured Command Code executable.', error));
child.on('close', (code, signal) => {
  childExit = {code, signal};
  // `exit` is too early: stdout can still contain the final reply. Never process.exit
  // before Node has drained our own stdout, especially after a large replay.
  clearTimeout(finishTimer); clearInterval(watchdog);
  if (!stopping && !clientEnded && requests.size) fail('Command Code closed before replying to outstanding ACP requests.');
  if (!stopping && !clientEnded && (code !== 0 || signal)) failureReport('unexpected_native_exit', undefined, true);
  finishFailureReport();
  clearTimeout(finishTimer);
  stopping = true;
  clientLines.close(); agentLines.close(); process.stdin.destroy();
  log('closed', {code, signal, clientEnded, ...counters});
  process.exitCode = process.exitCode || code || (signal ? 1 : 0);
  process.stdout.end();
});
process.on('uncaughtException', error => fail('Uncaught bridge exception.', error));
process.on('unhandledRejection', error => fail('Unhandled bridge rejection.', error));
for (const signal of ['SIGTERM','SIGINT','SIGHUP']) process.on(signal, () => {
  if (stopping) return;
  stopping = true; child.kill(signal); armTermination();
});
log('started', {idleMs, cancelMs});
