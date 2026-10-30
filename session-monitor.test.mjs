// Smoke test for session-monitor.ts — runs the real mod factory against a stubbed ModApi.
// Usage: node session-monitor.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the mod's bundle hydration at a real CLI install when one is present, BEFORE importing,
// so the runtime catalog extraction is exercised too.
const DIST_INDEX = '/usr/local/lib/node_modules/command-code/dist/index.mjs';
if (fs.existsSync(DIST_INDEX)) process.argv[1] = DIST_INDEX;

const {default: createSessionMonitor, __test} = await import('./session-monitor.ts');

let checks = 0;
const ok = (label) => {
	checks += 1;
	console.log(`  ✓ ${label}`);
};

function makeStub(sharedEntries = []) {
	const handlers = new Map();
	const hooks = {};
	const commands = new Map();
	const flags = new Map();
	const statuses = [];
	const notices = [];
	const cmd = {
		name: 'session-monitor',
		cwd: process.cwd(),
		events: {emit() {}, on() { return {dispose() {}}; }},
		ui: {
			notify(message, level) { notices.push({message, level}); },
			select: async () => undefined,
			setStatus(text) { statuses.push(text); return {dispose() {}}; },
			capabilities: {status: true},
			widget() { return {dispose() {}}; },
			refreshWidgets() {},
		},
		session: {
			appendCustomEntry(entry) { sharedEntries.push(entry); },
			getCustomEntries({customType}) {
				return sharedEntries
					.filter((entry) => entry.customType === customType)
					.map((entry, index) => ({id: String(index), ...entry}));
			},
			appendCustomMessageEntry() { return {entryId: 'stub', message: {}}; },
		},
		sessions: {},
		addFlag(name, spec) { flags.set(name, spec); },
		getFlag(name) { return flags.get(name)?.default; },
		addCommand(command) { commands.set(command.name, command); },
		addTool() { return {dispose() {}}; },
		addRenderer() { return {dispose() {}}; },
		addProvider() { return {dispose() {}}; },
		on(type, handler) { handlers.set(type, handler); return {dispose() {}}; },
		hooks(h) { Object.assign(hooks, h); return {dispose() {}}; },
		setModel() {}, setEffort() {}, setSessionName() {}, queueMessage() {}, showEntry() {},
		getModel() { return undefined; },
		getEffort() { return undefined; },
		getContextUsage() { return undefined; },
		async exec() { return {stdout: '', stderr: '', code: 0}; },
		getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
	};
	return {cmd, handlers, hooks, commands, statuses, notices, entries: sharedEntries};
}

const emit = (stub, type, event) => stub.handlers.get(type)({type, ...event});
const tokens = (stub, args = '') =>
	stub.commands.get('tokens').handler({args, ui: stub.cmd.ui, cwd: process.cwd(), exec: stub.cmd.exec});
const con = (stub) =>
	stub.commands.get('con').handler({args: '', ui: stub.cmd.ui, cwd: process.cwd(), exec: stub.cmd.exec});
const com = (stub) =>
	stub.commands.get('com').handler({args: '', ui: stub.cmd.ui, cwd: process.cwd(), exec: stub.cmd.exec});
const plain = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, '');

/* ---------- 1. catalog extraction ---------- */
__test.scan('Q:{id:"test/alpha-model",contextWindow:12345,reasoningEfforts:["low","high"]}');
assert.equal(__test.catalog.get('test/alpha-model')?.ctx, 12345);
assert.deepEqual(__test.catalog.get('test/alpha-model')?.efforts, ['low', 'high']);
ok('bundle scanner parses contextWindow + reasoningEfforts');

if (fs.existsSync(DIST_INDEX)) {
	const staticCount = Object.keys(__test.STATIC_CATALOG).length;
	assert.ok(staticCount >= 80, `static catalog size ${staticCount}`);
	// Delete an entry the static table knows, then let hydration restore it:
	// proving the scan actually re-read the installed bundle.
	__test.catalog.delete('claude-haiku-4-5-20251001');
	__test.hydrate();
	assert.equal(__test.catalog.get('claude-haiku-4-5-20251001')?.ctx, 2e5, 'hydration restored the deleted entry');
	assert.ok(__test.catalog.size >= staticCount, `hydrated catalog size ${__test.catalog.size}`);
	assert.equal(__test.catalog.get('claude-sonnet-5-5')?.ctx, 1e6);
	ok(`runtime hydration read the installed bundle (${__test.catalog.size} models)`);
} else {
	console.log('  - skipped bundle hydration (no install at the expected path)');
}

/* ---------- 2. registration ---------- */
const stub = makeStub();
createSessionMonitor(stub.cmd);
assert.ok(stub.commands.has('tokens'), 'registers /tokens');
assert.ok(stub.commands.has('con'), 'registers /con');
assert.ok(stub.commands.has('com'), 'registers /com');
for (const event of ['model_request_start', 'model_request_end', 'turn_end', 'config_setting_changed', 'permission_mode_changed', 'run_start', 'subagent_start', 'subagent_stop', 'text_delta', 'thinking_delta']) {
	assert.ok(stub.handlers.has(event), `listens for ${event}`);
}
assert.equal(typeof stub.hooks.onSessionStart, 'function');
assert.equal(typeof stub.hooks.onRunEnd, 'function');
assert.equal(typeof stub.hooks.onSessionEnd, 'function');
assert.equal(typeof stub.hooks.beforeToolCall, 'function');
assert.equal(typeof stub.hooks.afterToolCall, 'function');
ok('registers command, flag, hooks and events');

/* ---------- 3. session start paints the footer ---------- */
stub.hooks.onSessionStart({source: 'startup'});
assert.ok(stub.statuses.length >= 1, 'status pushed on session start');
ok('session start pushes a footer status');

/* ---------- 4. request lifecycle: model + context percent ---------- */
emit(stub, 'model_request_start', {model: 'claude-sonnet-5-5'});
emit(stub, 'model_request_end', {
	model: 'claude-sonnet-5-5',
	usage: {
		inputTokens: 230400,
		outputTokens: 12300,
		cacheReadTokens: 1204000,
		cacheWriteTokens: 48000,
	},
	stopReason: 'end_turn',
});
const status = plain(stub.statuses.at(-1));
assert.match(status, /claude-sonnet-5-5/);
assert.match(status, /23%/);
assert.match(status, /230\.4k\/1M/);
ok('footer shows model, context percent and token counts');

/* ---------- 5. /tokens report ---------- */
let report = tokens(stub).message;
assert.match(report, /230,400/);
assert.match(report, /12,300/);
assert.match(report, /1,204,000/);
assert.match(report, /48,000/);
assert.match(report, /23%/);
assert.match(report, /requests 1 · turns/);
ok('/tokens reports input, output and cache totals');

/* ---------- 6. unknown model: tokens only, no percent ---------- */
emit(stub, 'model_request_start', {model: 'byok/mystery-model'});
emit(stub, 'model_request_end', {model: 'byok/mystery-model', usage: {inputTokens: 5000}});
assert.match(plain(stub.statuses.at(-1)), /ctx 5k tokens/);
ok('unknown model degrades to raw token count');

/* ---------- 7. subagent guard keeps the main context ---------- */
const frozen = stub.statuses.at(-1);
emit(stub, 'subagent_start', {});
emit(stub, 'model_request_end', {model: 'byok/mystery-model', usage: {inputTokens: 999999}});
assert.equal(stub.statuses.at(-1), frozen, 'context unchanged while a subagent runs');
emit(stub, 'subagent_stop', {});
emit(stub, 'model_request_end', {model: 'byok/mystery-model', usage: {inputTokens: 12345}});
assert.match(plain(stub.statuses.at(-1)), /ctx 12\.3k tokens/);
ok('subagent requests do not overwrite the context reading');

/* ---------- 8. effort change event refreshes the footer ---------- */
emit(stub, 'config_setting_changed', {setting: 'effort', value: 'high'});
assert.match(plain(stub.statuses.at(-1)), /high/);
emit(stub, 'config_setting_changed', {setting: 'model', value: 'claude-sonnet-5-5'});
assert.match(plain(stub.statuses.at(-1)), /claude-sonnet-5-5/);
ok('model/effort changes update the footer live');

/* ---------- 9. reset ---------- */
assert.match(tokens(stub, 'reset').message, /reset/i);
report = tokens(stub).message;
assert.match(report, /No model requests recorded/);
ok('/tokens reset clears the counters');

/* ---------- 10. hostile inputs never throw ---------- */
for (const handler of stub.handlers.values()) {
	handler(undefined);
	handler({});
	handler('nope');
	handler({usage: {inputTokens: 'x', outputTokens: null}});
}
stub.hooks.onRunEnd({state: {}, result: {}});
stub.hooks.onSessionEnd({reason: 'shutdown'});
ok('junk events are swallowed without throwing');

/* ---------- 11. persistence + resume ---------- */
const shared = [];
const first = makeStub(shared);
createSessionMonitor(first.cmd);
first.hooks.onSessionStart({source: 'startup'});
emit(first, 'model_request_end', {
	model: 'claude-sonnet-5-5',
	usage: {inputTokens: 100000, outputTokens: 2000, cacheReadTokens: 50000, cacheWriteTokens: 1000},
});
emit(first, 'turn_end', {turnNumber: 1, hadToolCalls: false, usage: {inputTokens: 100000, outputTokens: 2000}});
first.hooks.onRunEnd({state: {}, result: {}});
assert.ok(shared.length > 0, 'totals snapshot appended to the session');

const second = makeStub(shared);
createSessionMonitor(second.cmd);
second.hooks.onSessionStart({source: 'resume'});
report = tokens(second).message;
assert.match(report, /100,000/);
assert.match(report, /50,000/);
assert.match(report, /requests 1 · turns 1/);
ok('totals survive a session resume via custom entries');

/* ---------- 12. TPS: live estimate while streaming, exact when done ---------- */
{
	const rateStub = makeStub();
	createSessionMonitor(rateStub.cmd);
	rateStub.hooks.onSessionStart({source: 'startup'});
	assert.doesNotMatch(plain(rateStub.statuses.at(-1) ?? ''), /tps/);

	const realNow = Date.now;
	let clock = 1_000_000;
	Date.now = () => clock;
	try {
		emit(rateStub, 'model_request_start', {model: 'claude-sonnet-5-5'});
		clock += 300;
		emit(rateStub, 'text_delta', {delta: 'x'.repeat(400)}); // stream anchor is set here
		clock += 1000;
		emit(rateStub, 'text_delta', {delta: 'y'.repeat(400)}); // 800 chars ≈ 200 tokens over 1s
		assert.match(plain(rateStub.statuses.at(-1)), /tps ~200/);

		clock += 1000;
		emit(rateStub, 'model_request_end', {
			model: 'claude-sonnet-5-5',
			usage: {inputTokens: 10000, outputTokens: 380, cacheReadTokens: 0, cacheWriteTokens: 0},
		}); // 380 exact output tokens over 2s since the first delta
		assert.match(plain(rateStub.statuses.at(-1)), /tps 190/);
		assert.doesNotMatch(plain(rateStub.statuses.at(-1)), /~/);

		const rateReport = tokens(rateStub).message;
		assert.match(rateReport, /190 tok\/s \(last response\)/);
		assert.match(rateReport, /190 tok\/s \(session avg\)/);
	} finally {
		Date.now = realNow;
	}
	ok('live TPS while streaming, exact TPS at completion');
}

/* ---------- 13. cache hit rate in the footer and report ---------- */
{
	const cacheStub = makeStub();
	createSessionMonitor(cacheStub.cmd);
	cacheStub.hooks.onSessionStart({source: 'startup'});
	emit(cacheStub, 'model_request_start', {model: 'claude-sonnet-5-5'});
	emit(cacheStub, 'model_request_end', {
		model: 'claude-sonnet-5-5',
		usage: {inputTokens: 100000, outputTokens: 1000, cacheReadTokens: 80000, cacheWriteTokens: 5000},
	});
	assert.match(plain(cacheStub.statuses.at(-1)), /cache-hit 80%/);
	let cacheReport = tokens(cacheStub).message;
	assert.match(cacheReport, /80% \(last response\)/);
	assert.match(cacheReport, /80% \(session avg\)/);

	emit(cacheStub, 'model_request_start', {model: 'claude-sonnet-5-5'});
	emit(cacheStub, 'model_request_end', {
		model: 'claude-sonnet-5-5',
		usage: {inputTokens: 50000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0},
	});
	assert.match(plain(cacheStub.statuses.at(-1)), /cache-hit 0%/);
	cacheReport = tokens(cacheStub).message;
	assert.match(cacheReport, /0% \(last response\)/);
	assert.match(cacheReport, /53% \(session avg\)/);

	const noCache = makeStub();
	createSessionMonitor(noCache.cmd);
	noCache.hooks.onSessionStart({source: 'startup'});
	emit(noCache, 'model_request_end', {
		model: 'claude-sonnet-5-5',
		usage: {inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0},
	});
	assert.doesNotMatch(plain(noCache.statuses.at(-1)), /cache-hit/);
	assert.doesNotMatch(tokens(noCache).message, /cache hit/);
	ok('cache hit rate shown only when caching is in play');
}

/* ---------- 14. /con: live context report ---------- */
{
	const ctxStub = makeStub();
	createSessionMonitor(ctxStub.cmd);
	ctxStub.hooks.onSessionStart({source: 'startup'});
	assert.match(con(ctxStub).message, /No context measurement yet/);

	emit(ctxStub, 'model_request_start', {model: 'claude-sonnet-5-5'});
	emit(ctxStub, 'model_request_end', {
		model: 'claude-sonnet-5-5',
		usage: {inputTokens: 230400, outputTokens: 1000},
	});
	let contextReport = con(ctxStub).message;
	assert.match(contextReport, /claude-sonnet-5-5/);
	assert.match(contextReport, /230,400 tokens/);
	assert.match(contextReport, /1,000,000 tokens/);
	assert.match(contextReport, /769,600 tokens \(77%\)/);
	assert.match(contextReport, /23%/);

	// The host's live reading wins over the last event-derived value.
	ctxStub.cmd.getContextUsage = () => ({tokens: 640000, contextWindow: 1000000, percent: 64});
	ctxStub.cmd.getModel = () => 'claude-opus-5';
	ctxStub.cmd.getEffort = () => 'max';
	contextReport = con(ctxStub).message;
	assert.match(contextReport, /claude-opus-5 · effort max/);
	assert.match(contextReport, /640,000 tokens/);
	assert.match(contextReport, /64%/);
	assert.doesNotMatch(contextReport, /230,400/);

	// Unknown model: show the used count, no percentage.
	const unknownStub = makeStub();
	createSessionMonitor(unknownStub.cmd);
	unknownStub.hooks.onSessionStart({source: 'startup'});
	emit(unknownStub, 'model_request_end', {model: 'byok/mystery-model', usage: {inputTokens: 5000}});
	assert.match(con(unknownStub).message, /5,000 tokens/);
	assert.match(con(unknownStub).message, /window\s+unknown for this model/);
	ok('/con reports live context usage and degrades without a known window');
}

/* ---------- 15. /com: compaction over ACP ---------- */
{
	const compactStub = makeStub();
	createSessionMonitor(compactStub.cmd);
	compactStub.hooks.onSessionStart({source: 'startup'});
	assert.match((await com(compactStub)).message, /does not expose session compaction/);

	compactStub.cmd.sessions = {
		compact: async () => ({messagesBefore: 40, messagesAfter: 9, tokensSaved: 120000, totalTokensSaved: 120000}),
	};
	compactStub.cmd.getContextUsage = () => ({tokens: 140000, contextWindow: 1000000, percent: 14});
	let compacted = (await com(compactStub)).message;
	assert.match(compacted, /120,000 tokens freed/);
	assert.match(compacted, /40 → 9 messages/);
	assert.match(compacted, /Context is now 14% full \(140,000 \/ 1,000,000\)\./);

	compactStub.cmd.sessions = {compact: async () => { throw new Error('boom'); }};
	assert.match((await com(compactStub)).message, /compaction failed \(boom\)/);

	compactStub.cmd.sessions = {compact: async () => {}};
	assert.match((await com(compactStub)).message, /Compaction finished\./);
	ok('/com compacts through the host and reports the result, failing gracefully');
}

/* ---------- 16. plan gate: show the plan and ask before implementing ---------- */
{
	const plans = fs.mkdtempSync(path.join(os.tmpdir(), 'session-monitor-plans-'));
	__test.setPlansDir(plans);
	try {
		const planPath = path.join(plans, 'demo-plan.md');
		fs.writeFileSync(planPath, '# Plan\n\n1. Do the thing.\n');

		const stopStub = makeStub();
		createSessionMonitor(stopStub.cmd);
		stopStub.hooks.onSessionStart({source: 'startup'});
		let selectArgs;
		stopStub.cmd.ui.select = async (args) => {
			selectArgs = args;
			return 'Stop — I want to review the plan';
		};
		let gateResult = await stopStub.hooks.afterToolCall({
			toolCallId: 't1',
			toolName: 'write_file',
			input: {file_path: planPath},
			isError: false,
			state: {},
		});
		assert.equal(gateResult?.terminate, true);
		assert.match(gateResult?.additionalContext, /stopped the run/);
		assert.equal(selectArgs.title, 'Plan ready — approve implementation?');
		assert.ok(stopStub.notices.some((n) => /Plan written to/.test(n.message) && /Do the thing/.test(n.message)));
		assert.equal(stopStub.notices.at(-1).level, 'warning');

		// After Stop, same-batch implementation calls are blocked, but plan edits still work.
		const outputPath = path.join(os.tmpdir(), 'session-monitor-output.txt');
		assert.equal(
			stopStub.hooks.beforeToolCall({toolName: 'write_file', input: {file_path: outputPath}})?.block,
			true,
		);
		assert.equal(stopStub.hooks.beforeToolCall({toolName: 'write_file', input: {file_path: planPath}}), undefined);
		emit(stopStub, 'run_start', {});
		assert.equal(stopStub.hooks.beforeToolCall({toolName: 'write_file', input: {file_path: outputPath}}), undefined);

		const approveStub = makeStub();
		createSessionMonitor(approveStub.cmd);
		approveStub.hooks.onSessionStart({source: 'startup'});
		approveStub.cmd.ui.select = async () => 'Approve — implement this plan';
		gateResult = await approveStub.hooks.afterToolCall({toolName: 'write_file', input: {file_path: planPath}, isError: false});
		assert.match(gateResult?.additionalContext, /approved the plan/);
		assert.equal(gateResult?.terminate, undefined);
		assert.equal(
			approveStub.hooks.beforeToolCall({toolName: 'write_file', input: {file_path: outputPath}}),
			undefined,
		);

		// The built-in review owns the decision in default/plan mode; only surface the plan.
		const planModeStub = makeStub();
		createSessionMonitor(planModeStub.cmd);
		planModeStub.hooks.onSessionStart({source: 'startup'});
		emit(planModeStub, 'permission_mode_changed', {mode: 'plan'});
		let asked = false;
		planModeStub.cmd.ui.select = async () => {
			asked = true;
			return 'Approve — implement this plan';
		};
		gateResult = await planModeStub.hooks.afterToolCall({toolName: 'write_file', input: {file_path: planPath}, isError: false});
		assert.equal(gateResult, undefined);
		assert.equal(asked, false);
		assert.ok(planModeStub.notices.length > 0);

		// Non-plan files and a disabled flag are ignored.
		const notesPath = path.join(plans, 'notes.txt');
		fs.writeFileSync(notesPath, 'hello');
		const quietStub = makeStub();
		createSessionMonitor(quietStub.cmd);
		quietStub.hooks.onSessionStart({source: 'startup'});
		quietStub.cmd.ui.select = async () => {
			throw new Error('should not ask');
		};
		assert.equal(
			await quietStub.hooks.afterToolCall({toolName: 'write_file', input: {file_path: notesPath}, isError: false}),
			undefined,
		);
		assert.equal(quietStub.notices.length, 0);

		const offStub = makeStub();
		createSessionMonitor(offStub.cmd);
		offStub.hooks.onSessionStart({source: 'startup'});
		offStub.cmd.getFlag = (name) => (name === 'planGate' ? false : true);
		assert.equal(
			await offStub.hooks.afterToolCall({toolName: 'write_file', input: {file_path: planPath}, isError: false}),
			undefined,
		);
		assert.equal(offStub.notices.length, 0);

		// An explicit review tool, a failed write, and junk payloads never gate or throw.
		const explicitStub = makeStub();
		createSessionMonitor(explicitStub.cmd);
		explicitStub.hooks.onSessionStart({source: 'startup'});
		await explicitStub.hooks.afterToolCall({toolName: 'plan_review', input: {}, isError: false});
		explicitStub.cmd.ui.select = async () => {
			throw new Error('should not ask');
		};
		assert.equal(
			await explicitStub.hooks.afterToolCall({toolName: 'write_file', input: {file_path: planPath}, isError: false}),
			undefined,
		);
		assert.equal(await explicitStub.hooks.afterToolCall(undefined), undefined);
		assert.equal(await explicitStub.hooks.afterToolCall({toolName: 'write_file', input: {}, isError: false}), undefined);
		assert.equal(explicitStub.hooks.beforeToolCall(undefined), undefined);
		assert.equal(explicitStub.hooks.beforeToolCall({toolName: 'write_file', input: {}}), undefined);
		assert.equal(
			await explicitStub.hooks.afterToolCall({toolName: 'write_file', input: {file_path: planPath}, isError: true}),
			undefined,
		);
		ok('plan gate shows the plan and asks approve/stop outside default/plan modes');
	} finally {
		fs.rmSync(plans, {recursive: true, force: true});
		__test.setPlansDir(path.join(os.homedir(), '.commandcode', 'plans'));
	}
}

console.log(`\n✅ session-monitor: all ${checks} checks passed`);
