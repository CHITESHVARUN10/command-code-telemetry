#!/usr/bin/env node
// Route Command Code question permissions through ACP elicitation, never auto-approve them.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';

const executable = process.env.COMMAND_CODE_BINARY || '/usr/local/bin/cmd';
const child = spawn(executable, ['acp'], {stdio: ['pipe', 'pipe', 'inherit'], env: process.env});
const pending = new Map();
const usage = new Map();
const nativeContext = new Set();
const nativeCompactAlias = new Set();
const activePrompts = new Map();
const prefix = `cc-question-${randomUUID()}-`;
let seq = 0;
const sendClient = value => process.stdout.write(JSON.stringify(value) + '\n');
const sendAgent = value => child.stdin.write(JSON.stringify(value) + '\n');
function question(params) {
  const call = params?.toolCall, raw = call?.rawInput, options = params?.options;
  if (call?.kind !== 'other' || !raw || typeof raw.question !== 'string') return null;
  if (!Array.isArray(raw.options)) return false;
  const labels = raw.options;
  if (labels.length < 2 || labels.length > 4 || !Array.isArray(options) || options.length !== labels.length ||
      labels.some(x => typeof x !== 'string' || !x.trim()) || new Set(labels).size !== labels.length ||
      options.some((o, i) => o.kind !== 'allow_once' || o.optionId !== `option_${i}` ||
        typeof o.name !== 'string' || !(o.name === labels[i] || o.name.startsWith(`${labels[i]}: `)))) return false;
  return {labels, options, call};
}
createInterface({input: child.stdout}).on('line', line => {
  let m; try { m = JSON.parse(line); } catch { process.stderr.write('Invalid JSON from Command Code\n'); return; }
  if (m.method === 'session/update') {
    const sessionId = m.params?.sessionId, update = m.params?.update;
    if (typeof sessionId === 'string' && update?.sessionUpdate === 'usage_update' &&
        Number.isFinite(update.used) && update.used >= 0 && Number.isFinite(update.size) && update.size > 0) {
      usage.set(sessionId, {used:update.used, size:update.size});
    }
    if (typeof sessionId === 'string' && update?.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      if (update.availableCommands.some(command => command.name === 'cccompact')) nativeCompactAlias.add(sessionId);
      else {
        nativeCompactAlias.delete(sessionId);
        update.availableCommands = [...update.availableCommands, {name:'cccompact', description:'Compact this Command Code session', input:null}];
      }
      if (update.availableCommands.some(command => command.name === 'context')) nativeContext.add(sessionId);
      else {
        nativeContext.delete(sessionId);
        update.availableCommands = [...update.availableCommands, {name:'context', description:'Show the last context usage reported by Command Code', input:null}];
      }
    }
  }
  if (m.id !== undefined && !m.method) activePrompts.delete(m.id);
  if (m.method === 'session/request_permission' && m.id !== undefined) {
    const q = question(m.params);
    if (q === false) { sendAgent({jsonrpc:'2.0',id:m.id,result:{outcome:{outcome:'cancelled'}}}); return; }
    if (q) {
      const id = prefix + ++seq;
      pending.set(id, {originalId:m.id, options:q.options, labels:q.labels});
      sendClient({jsonrpc:'2.0',id,method:'elicitation/create',params:{mode:'form',sessionId:m.params.sessionId,
        message: q.call.title || q.call.rawInput.question,
        requestedSchema:{type:'object',properties:{answer:{type:'string',title:'Select one option',description:q.call.rawInput.question,enum:q.labels}},required:['answer']}}});
      return;
    }
  }
  sendClient(m);
});
createInterface({input: process.stdin}).on('line', line => {
  let m; try { m = JSON.parse(line); } catch { process.stderr.write('Invalid JSON from ACP client\n'); return; }
  const entry = pending.get(m.id);
  if (entry && !m.method) {
    pending.delete(m.id);
    const answer = m.result?.action === 'accept' ? m.result?.content?.answer : undefined;
    const index = typeof answer === 'string' ? entry.labels.indexOf(answer) : -1;
    const outcome = index >= 0 ? {outcome:'selected',optionId:entry.options[index].optionId} : {outcome:'cancelled'};
    sendAgent({jsonrpc:'2.0',id:entry.originalId,result:{outcome}});
    return;
  }
  if (m.method === 'session/prompt' && m.id !== undefined) {
    const sessionId = m.params?.sessionId, prompt = m.params?.prompt;
    const contextCommand = typeof sessionId === 'string' && !nativeContext.has(sessionId) &&
      Array.isArray(prompt) && prompt.length === 1 && prompt[0]?.type === 'text' && prompt[0].text?.trim() === '/context';
    if (contextCommand) {
      if ([...activePrompts.values()].includes(sessionId)) {
        sendClient({jsonrpc:'2.0',id:m.id,error:{code:-32600,message:'A prompt is already running for this session'}});
        return;
      }
      const reading = usage.get(sessionId);
      const message = reading ? `Context (last reported by Command Code)\n\nUsed: ${Math.round(reading.used).toLocaleString()} tokens\nWindow: ${Math.round(reading.size).toLocaleString()} tokens\nFree: ${Math.max(0, Math.round(reading.size - reading.used)).toLocaleString()} tokens\nFill: ${Math.min(100, Math.max(0, Math.round(reading.used / reading.size * 100)))}%\n\nThis is an ACP host reading, not the terminal /context analysis. It may be an estimate and may not immediately reflect compaction.` : 'No context usage has been reported for this session yet. Send a model request and try again.';
      sendClient({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:message}}}});
      sendClient({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}});
      return;
    }
    if (typeof sessionId === 'string' && !nativeCompactAlias.has(sessionId) && Array.isArray(prompt) && prompt.length === 1 && prompt[0]?.type === 'text' && prompt[0].text?.trim() === '/cccompact') {
      m = {...m, params:{...m.params, prompt:[{...prompt[0], text:'/compact'}]}};
    }
    if (typeof sessionId === 'string') activePrompts.set(m.id, sessionId);
  }
  if (m.method === 'session/close' && typeof m.params?.sessionId === 'string') {
    usage.delete(m.params.sessionId); nativeContext.delete(m.params.sessionId); nativeCompactAlias.delete(m.params.sessionId);
  }
  sendAgent(m);
});
process.stdin.on('end', () => child.stdin.end());
child.on('error', error => {process.stderr.write(`Command Code bridge: ${error.message}\n`); process.exitCode = 1;});
child.on('exit', (code, signal) => {if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1);});
