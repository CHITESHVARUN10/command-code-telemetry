// Opt-in test against an installed, authenticated Command Code. No model call.
// A disposable MCP server verifies real editor-supplied tool discovery. It does
// not render HTML or contact T3. Never run against an existing session ID.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';

const dir = await mkdtemp(join(tmpdir(), 'cc-visual-mcp-smoke-'));
const probe = join(dir, 'probe.mjs'), callsPath = join(dir, 'calls.ndjson');
await writeFile(probe, `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const tools = ['html_preview','html_render'].map(name => ({name,
 description:'Disposable discovery probe only; does not render HTML.',
 inputSchema:{type:'object', properties:{html:{type:'string'}}, required:['html']}}));
createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 appendFileSync(process.env.PROBE_CALLS, JSON.stringify({method:m.method}) + '\\n');
 if (m.id === undefined) return;
 const result = m.method === 'initialize'
  ? {protocolVersion:m.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'visual-discovery-probe', version:'1'}}
  : m.method === 'tools/list' ? {tools} : {};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result}) + '\\n');
});
`);

const bridge = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('./bridge.mjs', import.meta.url));
const child = spawn(process.execPath, [bridge], {cwd:dir,
  env:{...process.env, COMMAND_CODE_BRIDGE_LOG:'', COMMAND_CODE_BRIDGE_IDLE_MS:'0'}, stdio:['pipe','pipe','pipe']});
let seq = 0, stderr = '', sessionId, closed = false;
const pending = new Map();
const completion = new Promise(resolve => child.on('close', (code) => {
  closed = true;
  for (const entry of pending.values()) {clearTimeout(entry.timer); entry.reject(new Error('Provider closed before replying'));}
  pending.clear(); resolve(code);
}));
child.stderr.on('data', data => {stderr += data;});
child.on('error', () => { /* Close handler settles any pending request. */ });
createInterface({input:child.stdout}).on('line', line => {
  const message = JSON.parse(line), entry = pending.get(message.id);
  if (!entry) return;
  clearTimeout(entry.timer); pending.delete(message.id);
  // Do not echo native error payloads or configuration credentials.
  if (message.error) entry.reject(new Error('Native request failed with JSON-RPC code ' + message.error.code));
  else entry.resolve(message.result);
});
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => {pending.delete(id); reject(new Error('Timed out: ' + method));}, 30_000);
  pending.set(id, {resolve, reject, timer});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0', id, method, params}) + '\n');
});

try {
  const initialized = await request('initialize', {protocolVersion:2, clientInfo:{name:'bridge-discovery-smoke', version:'1'}, clientCapabilities:{elicitation:{form:{}}}});
  const created = await request('session/new', {cwd:dir, mcpServers:[{name:'t3-code', command:process.execPath, args:[probe], env:[{name:'PROBE_CALLS', value:callsPath}]}]});
  sessionId = created.sessionId;
  assert.equal(typeof sessionId, 'string');
  const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
  assert.ok(calls.includes('initialize'), 'Command Code did not initialize the editor MCP server');
  assert.ok(calls.includes('tools/list'), 'Command Code did not discover its tools');
  assert.match(stderr, /mcp t3-code \(editor\): 2 tools/, 'Command Code did not confirm both probe tools loaded');
  await request('session/close', {sessionId}); sessionId = undefined;
  console.log(JSON.stringify({ok:true, nativeVersion:initialized.agentInfo?.version,
    toolsDiscovered:['html_preview','html_render'], modelCalls:0,
    scope:'Real Command Code editor-MCP discovery only; no T3 UI rendering test'}));
} finally {
  if (sessionId && !closed) await request('session/close', {sessionId}).catch(() => {});
  child.stdin.end();
  const kill = setTimeout(() => child.kill('SIGKILL'), 2_000);
  await completion; clearTimeout(kill);
  await rm(dir, {recursive:true, force:true});
}
