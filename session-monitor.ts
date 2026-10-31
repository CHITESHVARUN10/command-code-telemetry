/**
 * session-monitor — a Command Code mod.
 *
 *   Footer  ⬡ <model> · effort <level> · ctx <n>% (<used>/<limit>)
 *   Commands
 *     /tokens [reset] — input / output / cache-read / cache-write totals for this session
 *     /con  — live context usage (used / window / fill) as plain text, so ACP clients see it
 *     /com  — compact the conversation now (the /compact action, callable over ACP)
 *
 * Built strictly against the documented ModApi (https://commandcode.ai/docs/mods) so it keeps
 * working across Command Code upgrades: every host field is validated, handlers never throw,
 * the footer degrades to raw token counts when a model is unknown, and the
 * model -> context-window map re-hydrates from whichever CLI bundle is installed at runtime
 * (STATIC_CATALOG is only the offline fallback).
 *
 * Install: copy this file to ~/.commandcode/mods/session-monitor.ts, then `/reload` (or restart).
 * Test without installing:  cmd --mod ./session-monitor.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {ModApi} from '@commandcode/harness';

/* ------------------------------------------------------------------ catalog */

type ModelMeta = {ctx?: number; efforts?: string[]};

/** Offline fallback, mirrored from the installed Command Code catalog.
 *  The runtime hydration below normally refreshes/extends this from the live bundle. */
const STATIC_CATALOG: Record<string, [number, string[]]> = {
	'MiniMaxAI/MiniMax-M2.5': [2e5, []],
	'MiniMaxAI/MiniMax-M3': [1e6, ['low', 'medium', 'high']],
	'MiniMaxAI/MiniMax-M3-Free': [1e6, ['low', 'medium', 'high']],
	'Qwen/Qwen3.7-Flash': [1e6, []],
	'Qwen/Qwen3.7-Max': [1e6, []],
	'Qwen/Qwen3.7-Plus': [1e6, []],
	'Qwen/Qwen3.8-27B': [262144, ['low', 'medium', 'xhigh']],
	'Qwen/Qwen3.8-Flash': [1e6, ['low', 'medium', 'xhigh']],
	'Qwen/Qwen3.8-Max': [1e6, ['low', 'medium', 'xhigh']],
	'Qwen/Qwen3.8-Max-0902': [1e6, ['low', 'medium', 'xhigh']],
	'Qwen/Qwen3.8-Omni-Flash': [1e6, ['low', 'medium', 'xhigh']],
	'claude-fable-5': [1e6, ['low', 'medium', 'high', 'xhigh', 'max']],
	'claude-fable-5-1': [1e6, ['low', 'medium', 'high', 'xhigh', 'max']],
	'claude-haiku-4-5-20251001': [2e5, []],
	'claude-opus-4-7': [1e6, ['low', 'medium', 'high', 'xhigh', 'max']],
	'claude-opus-4-8': [1e6, ['low', 'medium', 'high', 'xhigh', 'max']],
	'claude-opus-5': [1e6, ['low', 'medium', 'high', 'xhigh', 'max']],
	'claude-opus-5-5': [1e6, ['low', 'medium', 'high', 'xhigh', 'max']],
	'claude-sonnet-4-6': [1e6, ['low', 'medium', 'high', 'xhigh', 'max']],
	'claude-sonnet-5': [1e6, ['low', 'medium', 'high', 'xhigh', 'max']],
	'claude-sonnet-5-5': [1e6, ['low', 'medium', 'high', 'xhigh', 'max']],
	'deepseek/deepseek-v4-flash': [1e6, ['off', 'high', 'max']],
	'deepseek/deepseek-v4-flash-fast': [1e6, ['low', 'high', 'max']],
	'deepseek/deepseek-v4-flash-vision-exp': [1e6, ['off', 'high', 'max']],
	'deepseek/deepseek-v4-pro': [1e6, ['off', 'high', 'max']],
	'deepseek/deepseek-v4.1-flash': [1e6, ['off', 'low', 'high', 'max']],
	'deepseek/deepseek-v4.1-flash-fast': [1e6, ['off', 'low', 'high', 'max']],
	'google/gemini-3.1-flash-lite': [1e6, ['low', 'medium', 'high']],
	'google/gemini-3.5-flash': [1e6, ['low', 'medium', 'high']],
	'google/gemini-3.5-flash-lite': [1e6, ['low', 'medium', 'high']],
	'google/gemini-3.6-flash': [1e6, ['low', 'medium', 'high']],
	'google/gemini-3.7-flash': [1048576, ['low', 'medium', 'high']],
	'google/gemini-3.8-flash': [1e6, ['low', 'medium', 'high']],
	'gpt-5.3-codex': [4e5, ['low', 'medium', 'high', 'xhigh']],
	'gpt-5.4': [4e5, ['low', 'medium', 'high', 'xhigh']],
	'gpt-5.4-mini': [4e5, ['low', 'medium', 'high']],
	'gpt-5.5': [4e5, ['low', 'medium', 'high', 'xhigh']],
	'gpt-5.6-luna': [105e4, ['low', 'medium', 'high', 'xhigh', 'max']],
	'gpt-5.6-sol': [105e4, ['low', 'medium', 'high', 'xhigh', 'max']],
	'gpt-5.6-terra': [105e4, ['low', 'medium', 'high', 'xhigh', 'max']],
	'gpt-6-astra': [105e4, ['low', 'medium', 'high', 'xhigh', 'max']],
	'gpt-6-luna': [105e4, ['low', 'medium', 'high', 'xhigh', 'max']],
	'gpt-6-sol': [105e4, ['low', 'medium', 'high', 'xhigh', 'max']],
	'gpt-6.1-sol': [105e4, ['low', 'medium', 'high', 'xhigh', 'max']],
	'inclusionai/ling-3.1-flash:free': [262144, ['low', 'medium', 'high']],
	'meituan/LongCat-2.0': [1048576, []],
	'meituan/LongCat-2.0:free': [1048576, []],
	'meta/muse-spark-1.1': [1048576, ['low', 'medium', 'high', 'xhigh']],
	'meta/muse-spark-1.2': [1048576, ['low', 'medium', 'high', 'xhigh']],
	'meta/muse-spark-1.2-contributor': [1048576, ['low', 'medium', 'high', 'xhigh']],
	'meta/muse-spark-1.3': [1048576, ['low', 'medium', 'high', 'xhigh', 'max']],
	'meta/muse-spark-1.3-contributor': [1048576, ['low', 'medium', 'high', 'xhigh']],
	'minimax/minimax-m2.7-free': [197e3, []],
	'minimax/minimax-m3-free': [1e6, ['low', 'medium', 'high']],
	'moonshotai/Kimi-K2.5': [256e3, []],
	'moonshotai/Kimi-K2.6': [256e3, []],
	'moonshotai/Kimi-K2.7-Code': [256e3, []],
	'moonshotai/Kimi-K2.7-Code-Highspeed': [262e3, []],
	'moonshotai/Kimi-K3': [1e6, ['low', 'high', 'max']],
	'nvidia/nemotron-3-ultra-550b-a55b': [1e6, []],
	'poolside/laguna-s-2.1-free': [256e3, []],
	'sakana/fugu-ultra': [1e6, ['high', 'xhigh']],
	'stealth/pixel-canary': [262144, ['low', 'medium', 'xhigh']],
	'stealth/space-bunny-alpha': [1e6, ['low', 'medium', 'high', 'max']],
	'stepfun/Step-3.5-Flash': [262144, []],
	'stepfun/Step-3.7-Flash': [256e3, []],
	'stepfun/Step-5-Preview': [1e6, ['low', 'medium', 'high']],
	'tencent/Hy3': [262144, []],
	'tencent/hy3-paid': [262144, []],
	'tencent/hy4-preview': [1048576, ['low', 'medium', 'high']],
	'thinkingmachines/inkling': [256e3, []],
	'thinkingmachines/inkling-small': [1e6, []],
	'xai/grok-4.5': [5e5, ['low', 'medium', 'high']],
	'xai/grok-4.6': [5e5, ['low', 'medium', 'high', 'xhigh']],
	'xai/grok-4.7': [5e5, ['low', 'medium', 'high', 'xhigh']],
	'xiaomi/mimo-v2.5': [1e6, []],
	'xiaomi/mimo-v2.5-pro': [1e6, []],
	'xiaomi/mimo-v2.6-flash': [1048576, []],
	'xiaomi/mimo-v2.6-pro': [1048576, []],
	'xiaomi/mimo-v2.6-pro-ultraspeed': [1048576, []],
	'z-ai/glm-5.3-flash': [1048576, ['low', 'high', 'max']],
	'z-ai/glm-5.3-flashx': [1e6, ['low', 'high', 'max']],
	'zai-org/GLM-5': [2e5, []],
	'zai-org/GLM-5.2': [1e6, ['high', 'max']],
	'zai-org/GLM-5.2-Fast': [1e6, []],
	'zai-org/GLM-5.3': [1e6, ['low', 'high', 'max']],
	// Catalog additions carried in newer bundles — the runtime scan normally picks these up
	// on its own; they're mirrored here so the offline fallback stays current too.
	'Qwen/Qwen3.8-Max-Prime': [1e6, ['low', 'medium', 'xhigh']],
	'claude-haiku-5-5': [1e6, ['low', 'medium', 'high', 'xhigh', 'max']],
	'google/gemini-4-argon': [1e6, ['low', 'medium', 'high']],
	'inclusionai/ling-3.1-flash': [262144, ['low', 'medium', 'high']],
	'meta/muse-spark-open': [1048576, ['low', 'medium', 'high']],
	'meta/muse-wonder-1.0': [1048576, ['low', 'medium', 'high', 'xhigh']],
	'mistral/mistral-large-4': [524288, ['low', 'medium', 'high']],
	'nvidia/nemotron-3.5-super-vl': [262144, ['low', 'medium', 'high']],
	'stealth/cat-jam:free': [1048576, ['low', 'medium', 'high', 'xhigh', 'max']],
	'stealth/glyph-cluster:free': [256e3, ['low', 'medium', 'high', 'xhigh']],
};

const catalog = new Map<string, ModelMeta>();
for (const [id, [ctx, efforts]] of Object.entries(STATIC_CATALOG)) {
	catalog.set(id, {ctx, efforts: efforts.slice()});
}

let catalogHydrated = false;

/** Locate plausible CLI bundles relative to the running entry point. */
function bundleCandidates(): string[] {
	const dir = path.dirname(process.argv[1] ?? '');
	return [
		path.join(dir, 'cli.mjs'),
		path.join(dir, 'index.mjs'),
		path.join(dir, '..', 'dist', 'cli.mjs'),
	].filter((p, i, all) => p && all.indexOf(p) === i);
}

/** Best-effort re-read of the installed catalog so new models/efforts keep working. */
function hydrateCatalog(): void {
	if (catalogHydrated) return;
	catalogHydrated = true;
	for (const file of bundleCandidates()) {
		try {
			const stat = fs.statSync(file);
			if (!stat.isFile() || stat.size < 50_000 || stat.size > 64 * 1024 * 1024) continue;
			const text = fs.readFileSync(file, 'utf8');
			if (!text.includes('contextWindow') && !text.includes('reasoningEfforts')) continue;
			scanModelCatalog(text);
			return;
		} catch {
			/* try the next candidate */
		}
	}
}

function scanModelCatalog(text: string): void {
	const idRe = /id:"([^"]+)"/g;
	let match: RegExpExecArray | null;
	let seen = 0;
	while ((match = idRe.exec(text)) !== null && seen < 20000) {
		seen += 1;
		const id = match[1];
		if (!id || id.length < 3) continue;
		const cut = Math.min(text.length, idRe.lastIndex + 1600);
		const nextId = text.indexOf('id:"', idRe.lastIndex);
		const end = nextId !== -1 && nextId < cut ? nextId : cut;
		const segment = text.slice(idRe.lastIndex, end);
		const ctxMatch = /contextWindow:([0-9]+(?:\.[0-9]+)?(?:[eE][0-9]+)?)/.exec(segment);
		const effortsMatch = /reasoningEfforts:\[([^\]]*)\]/.exec(segment);
		if (!ctxMatch && !effortsMatch) continue;
		const meta = catalog.get(id) ?? {};
		if (ctxMatch) {
			const n = Number(ctxMatch[1]);
			if (Number.isFinite(n) && n > 0) meta.ctx = n;
		}
		if (effortsMatch) {
			const efforts = effortsMatch[1]
				.split(',')
				.map((s) => s.replace(/"/g, '').trim())
				.filter(Boolean);
			if (efforts.length > 0) meta.efforts = efforts;
		}
		catalog.set(id, meta);
	}
}

/* ------------------------------------------------------------------ user config */

type UserConfig = {model?: string; reasoningEffort?: Record<string, string>};

let configCache: {at: number; value: UserConfig | undefined} = {at: 0, value: undefined};

function readUserConfig(): UserConfig | undefined {
	const now = Date.now();
	if (now - configCache.at < 1000) return configCache.value;
	configCache = {at: now, value: loadUserConfig()};
	return configCache.value;
}

function loadUserConfig(): UserConfig | undefined {
	try {
		const dir = path.join(os.homedir(), '.commandcode');
		const merged: UserConfig = {};
		let found = false;
		for (const name of ['config.json', 'config.local.json', 'config.staging.json']) {
			try {
				const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
					Object.assign(merged, parsed);
					found = true;
				}
			} catch {
				/* file may not exist - keep going */
			}
		}
		return found ? merged : undefined;
	} catch {
		return undefined;
	}
}

/* ------------------------------------------------------------------ small utils */

const asRecord = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const asCount = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

const asOptionalCount = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function safe<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => void {
	return (...args) => {
		try {
			fn(...args);
		} catch {
			/* a broken handler must never surface as a mod_error */
		}
	};
}

const ANSI = {
	reset: '\x1b[0m',
	dim: '\x1b[2m',
	bold: '\x1b[1m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	magenta: '\x1b[35m',
	cyan: '\x1b[36m',
	red: '\x1b[31m',
};

const EFFORT_COLOR: Record<string, string> = {
	off: ANSI.dim,
	default: ANSI.dim,
	low: ANSI.green,
	medium: ANSI.cyan,
	high: ANSI.yellow,
	xhigh: ANSI.magenta,
	max: ANSI.red,
};

const TOTAL_ENTRY = 'session-monitor/totals';

/* ------------------------------------------------------------------ plan gate */

/** Command Code's plan directory; tests override it through __test.setPlansDir. */
let plansDir = path.join(os.homedir(), '.commandcode', 'plans');

function resolvePlanPath(rawPath: string, cwd: string): string | undefined {
	const expanded =
		rawPath === '~' ? os.homedir() : rawPath.startsWith('~/') ? path.join(os.homedir(), rawPath.slice(2)) : rawPath;
	let resolved = path.resolve(cwd, expanded);
	try {
		resolved = fs.realpathSync(resolved);
	} catch {
		/* the plan may have been removed already */
	}
	let dir = plansDir;
	try {
		dir = fs.realpathSync(dir);
	} catch {
		dir = path.resolve(dir);
	}
	const win = process.platform === 'win32';
	const candidate = win ? resolved.toLowerCase() : resolved;
	const base = win ? dir.toLowerCase() : dir;
	if (candidate === base || !candidate.startsWith(`${base}${path.sep}`)) return undefined;
	return candidate.toLowerCase().endsWith('.md') ? resolved : undefined;
}

function readPlanText(file: string): string | undefined {
	try {
		const text = fs.readFileSync(file, 'utf8');
		return text.trim() ? text : undefined;
	} catch {
		return undefined;
	}
}

/* ------------------------------------------------------------------ speed */

/** The CLI's own char->token estimator is Math.ceil(chars / 4); live TPS uses the same basis. */
const CHARS_PER_TOKEN = 4;
/** Timings shorter than this are too noisy to turn into a rate. */
const MIN_RATE_MS = 200;
/** Sanity bound: reject absurd rates from bogus timings. */
const MAX_TPS = 5000;
/** Footer repaint throttle while a response streams. */
const LIVE_PAINT_MS = 400;

/** Test seams — not part of the mod surface. */
export const __test = {
	catalog,
	hydrate: hydrateCatalog,
	scan: scanModelCatalog,
	STATIC_CATALOG,
	setPlansDir: (dir: string) => {
		plansDir = dir;
	},
};

type Usage = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
};

/* ------------------------------------------------------------------ mod */

export default function sessionMonitor(cmd: ModApi): void {
	/* ---------- state ---------- */
	const totals = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, turns: 0};
	const perModel = new Map<string, Usage>();
	let model: string | undefined;
	let effort: string | undefined;
	let effortSetAt = 0;
	let ctxTokens: number | undefined;
	let subagents = 0;
	// TPS: a live estimate while streaming, the exact value once a request completes.
	let liveTps: number | undefined;
	let lastTps: number | undefined;
	// Cache-hit share of the latest request's input (cache read ÷ total input).
	let lastCacheHitPct: number | undefined;
	let requestStartedAt: number | undefined;
	let streamStartedAt: number | undefined;
	let streamChars = 0;
	let lastLivePaintAt = 0;
	let genMs = 0;
	let genTokens = 0;
	// Plan gate: track the live mode, reviewed plans, and whether the user stopped after review.
	let permissionMode: string | undefined;
	const gatedPlans = new Set<string>();
	let explicitPlanReview = false;
	let planStopped = false;

	/* ---------- formatting ---------- */
	const shortModel = (id: string): string => {
		const slash = id.lastIndexOf('/');
		return slash >= 0 ? id.slice(slash + 1) : id;
	};

	const fmtInt = (n: number): string =>
		Math.round(n)
			.toString()
			.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

	const fmtCompact = (n: number): string => {
		if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
		if (n >= 1e3) return `${Math.round(n / 100) / 10}k`;
		return String(Math.round(n));
	};

	/* ---------- config-derived model / effort ---------- */
	const configuredModel = (): string | undefined => {
		const value = readUserConfig()?.model;
		return typeof value === 'string' && value ? value : undefined;
	};

	const configuredEffort = (modelId: string | undefined): string | undefined => {
		if (!modelId) return undefined;
		const mapEffort = readUserConfig()?.reasoningEffort;
		if (!mapEffort || typeof mapEffort !== 'object' || Array.isArray(mapEffort)) return undefined;
		const value = (mapEffort as Record<string, unknown>)[modelId];
		return typeof value === 'string' && value ? value : undefined;
	};

	const refreshEffort = (): void => {
		if (!model) {
			effort = undefined;
			return;
		}
		const fromConfig = configuredEffort(model);
		if (fromConfig) {
			effort = fromConfig;
			effortSetAt = 0;
			return;
		}
		// No persisted pick: only drop a value once the config file has had time to catch up.
		if (Date.now() - effortSetAt > 3000) effort = undefined;
	};

	/* ---------- status footer ---------- */
	const contextPiece = (): string => {
		const label = `${ANSI.dim}ctx${ANSI.reset}`;
		if (ctxTokens === undefined) return `${label} ${ANSI.dim}—${ANSI.reset}`;
		const limit = model ? catalog.get(model)?.ctx : undefined;
		if (typeof limit === 'number' && limit > 0) {
			const pct = Math.min(100, Math.round((ctxTokens / limit) * 100));
			const color = pct >= 90 ? ANSI.red : pct >= 80 ? ANSI.yellow : ANSI.green;
			const showTokens = cmd.getFlag('showTokens') !== false;
			const detail = showTokens
				? ` ${ANSI.dim}(${fmtCompact(ctxTokens)}/${fmtCompact(limit)})${ANSI.reset}`
				: '';
			return `${label} ${color}${pct}%${ANSI.reset}${detail}`;
		}
		return `${label} ${fmtCompact(ctxTokens)}${ANSI.dim} tokens${ANSI.reset}`;
	};

	const tpsPiece = (): string | undefined => {
		const rate = liveTps ?? lastTps;
		if (rate === undefined) return undefined;
		// `~` marks the live streaming estimate; the plain value is the exact completed rate.
		const value = liveTps !== undefined ? `~${Math.round(liveTps)}` : String(Math.round(rate));
		return `${ANSI.dim}tps${ANSI.reset} ${value}`;
	};

	const cacheHitPiece = (): string | undefined => {
		if (lastCacheHitPct === undefined) return undefined;
		// Only meaningful once the provider has actually reported cache activity.
		if (!(totals.cacheRead > 0 || totals.cacheWrite > 0)) return undefined;
		return `${ANSI.dim}cache-hit${ANSI.reset} ${Math.round(lastCacheHitPct)}%`;
	};

	const statusText = (): string | undefined => {
		const pieces: string[] = [];
		if (model) {
			pieces.push(`${ANSI.bold}${shortModel(model)}${ANSI.reset}`);
			const meta = catalog.get(model);
			const shown = effort ?? (meta?.efforts && meta.efforts.length > 0 ? 'default' : undefined);
			if (shown) {
				const color = EFFORT_COLOR[shown] ?? '';
				pieces.push(`${ANSI.dim}effort${ANSI.reset} ${color}${shown}${ANSI.reset}`);
			}
		}
		if (!model && ctxTokens === undefined) return undefined;
		pieces.push(contextPiece());
		const tps = tpsPiece();
		if (tps) pieces.push(tps);
		const cacheHit = cacheHitPiece();
		if (cacheHit) pieces.push(cacheHit);
		return `${ANSI.dim}⬡${ANSI.reset} ${pieces.join(` ${ANSI.dim}·${ANSI.reset} `)}`;
	};

	const pushStatus = (): void => {
		try {
			if (cmd.ui?.capabilities && cmd.ui.capabilities.status === false) return;
			if (typeof cmd.ui?.setStatus !== 'function') return;
			hydrateCatalog();
			cmd.ui.setStatus(statusText() ?? null);
		} catch {
			/* never break the session over a footer segment */
		}
	};

	/* ---------- usage accounting ---------- */
	const readUsage = (event: Record<string, unknown>): Usage | undefined => {
		const raw = event.usage;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
		const record = raw as Record<string, unknown>;
		const pick = (...keys: string[]): number => {
			for (const key of keys) {
				const value = record[key];
				if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
			}
			return 0;
		};
		return {
			inputTokens: pick('inputTokens', 'input_tokens', 'promptTokens'),
			outputTokens: pick('outputTokens', 'output_tokens', 'completionTokens'),
			cacheReadTokens: pick('cacheReadTokens', 'cache_read_input_tokens', 'cachedReadTokens'),
			cacheWriteTokens: pick('cacheWriteTokens', 'cache_creation_input_tokens', 'cachedWriteTokens'),
		};
	};

	const accumulate = (forModel: string | undefined, usage: Usage): void => {
		totals.input += usage.inputTokens;
		totals.output += usage.outputTokens;
		totals.cacheRead += usage.cacheReadTokens;
		totals.cacheWrite += usage.cacheWriteTokens;
		totals.requests += 1;
		if (!forModel) return;
		const current = perModel.get(forModel) ?? {inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0};
		current.inputTokens += usage.inputTokens;
		current.outputTokens += usage.outputTokens;
		current.cacheReadTokens += usage.cacheReadTokens;
		current.cacheWriteTokens += usage.cacheWriteTokens;
		perModel.set(forModel, current);
	};

	const resetCounters = (): void => {
		totals.input = 0;
		totals.output = 0;
		totals.cacheRead = 0;
		totals.cacheWrite = 0;
		totals.requests = 0;
		totals.turns = 0;
		perModel.clear();
		genMs = 0;
		genTokens = 0;
		lastTps = undefined;
		lastCacheHitPct = undefined;
		liveTps = undefined;
		requestStartedAt = undefined;
		streamStartedAt = undefined;
		streamChars = 0;
	};

	/* ---------- persistence (survives resume, per session branch) ---------- */
	const snapshot = (): Record<string, unknown> => {
		const out: Record<string, unknown> = {
			v: 1,
			input: totals.input,
			output: totals.output,
			cacheRead: totals.cacheRead,
			cacheWrite: totals.cacheWrite,
			requests: totals.requests,
			turns: totals.turns,
			perModel: Object.fromEntries([...perModel].map(([id, value]) => [id, {...value}])),
		};
		if (model) out.model = model;
		if (ctxTokens !== undefined) out.ctxTokens = ctxTokens;
		if (genMs > 0) out.genMs = genMs;
		if (genTokens > 0) out.genTokens = genTokens;
		if (lastTps !== undefined) out.lastTps = lastTps;
		if (lastCacheHitPct !== undefined) out.lastCacheHitPct = lastCacheHitPct;
		return out;
	};

	const persist = (): void => {
		try {
			cmd.session?.appendCustomEntry?.({customType: TOTAL_ENTRY, data: snapshot()});
		} catch {
			/* persistence is best-effort */
		}
	};

	const seedFromSession = (): void => {
		try {
			const entries = cmd.session?.getCustomEntries?.({customType: TOTAL_ENTRY});
			if (!Array.isArray(entries) || entries.length === 0) return;
			for (let i = entries.length - 1; i >= 0; i -= 1) {
				const raw = (entries[i] as {data?: unknown} | undefined)?.data;
				if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
				const data = raw as Record<string, unknown>;
				totals.input = asCount(data.input);
				totals.output = asCount(data.output);
				totals.cacheRead = asCount(data.cacheRead);
				totals.cacheWrite = asCount(data.cacheWrite);
				totals.requests = asCount(data.requests);
				totals.turns = asCount(data.turns);
				genMs = asCount(data.genMs);
				genTokens = asCount(data.genTokens);
				if (typeof data.lastTps === 'number' && Number.isFinite(data.lastTps) && data.lastTps > 0) {
					lastTps = data.lastTps;
				}
				if (
					typeof data.lastCacheHitPct === 'number' &&
					Number.isFinite(data.lastCacheHitPct) &&
					data.lastCacheHitPct >= 0 &&
					data.lastCacheHitPct <= 100
				) {
					lastCacheHitPct = data.lastCacheHitPct;
				}
				const per = data.perModel;
				if (per && typeof per === 'object' && !Array.isArray(per)) {
					for (const [id, value] of Object.entries(per as Record<string, unknown>)) {
						if (!value || typeof value !== 'object') continue;
						const entry = value as Record<string, unknown>;
						perModel.set(id, {
							inputTokens: asCount(entry.inputTokens),
							outputTokens: asCount(entry.outputTokens),
							cacheReadTokens: asCount(entry.cacheReadTokens),
							cacheWriteTokens: asCount(entry.cacheWriteTokens),
						});
					}
				}
				if (typeof data.model === 'string' && data.model) model = data.model;
				if (typeof data.ctxTokens === 'number' && Number.isFinite(data.ctxTokens) && data.ctxTokens >= 0) {
					ctxTokens = data.ctxTokens;
				}
				return;
			}
		} catch {
			/* seeding is best-effort */
		}
	};

	/* ---------- /tokens report ---------- */
	const buildReport = (): string => {
		hydrateCatalog();
		const meta = model ? catalog.get(model) : undefined;
		const shown = effort ?? (meta?.efforts && meta.efforts.length > 0 ? 'default' : undefined);
		const lines: string[] = [
			`Session tokens — ${model ?? 'unknown model'}${shown ? ` · effort ${shown}` : ''}`,
		];
		if (totals.requests === 0) {
			lines.push('', '  No model requests recorded yet in this session.');
			return lines.join('\n');
		}
		const row = (label: string, value: number): string => `  ${label.padEnd(12)}${fmtInt(value).padStart(13)}`;
		lines.push(
			'',
			row('input', totals.input),
			row('output', totals.output),
			row('cache read', totals.cacheRead),
			row('cache write', totals.cacheWrite),
			`  ${'─'.repeat(25)}`,
			`  ${`requests ${totals.requests} · turns ${totals.turns}`.padEnd(25)}`,
			'',
			`  · input includes cache read/write`,
		);
		const limit = model ? catalog.get(model)?.ctx : undefined;
		if (ctxTokens !== undefined && typeof limit === 'number' && limit > 0) {
			const pct = Math.min(100, Math.round((ctxTokens / limit) * 100));
			lines.push(`  context      ${fmtInt(ctxTokens).padStart(13)} / ${fmtInt(limit)}  (${pct}%)`);
		} else if (ctxTokens !== undefined) {
			lines.push(`  context      ${fmtInt(ctxTokens).padStart(13)}  (window size unknown for this model)`);
		}
		const speed: string[] = [];
		if (lastTps !== undefined) speed.push(`${Math.round(lastTps)} tok/s (last response)`);
		if (genMs > 0 && genTokens > 0) {
			speed.push(`${Math.round(genTokens / (genMs / 1000))} tok/s (session avg)`);
		}
		if (speed.length > 0) lines.push(`  ${'speed'.padEnd(12)}${speed.join(' · ')}`);
		if (totals.cacheRead > 0 || totals.cacheWrite > 0) {
			const hits: string[] = [];
			if (lastCacheHitPct !== undefined) hits.push(`${Math.round(lastCacheHitPct)}% (last response)`);
			if (totals.input > 0) {
				hits.push(`${Math.round((totals.cacheRead / totals.input) * 100)}% (session avg)`);
			}
			if (hits.length > 0) lines.push(`  ${'cache hit'.padEnd(12)}${hits.join(' · ')}`);
		}
		if (perModel.size > 1) {
			lines.push('', '  per model');
			for (const [id, value] of perModel) {
				lines.push(
					`    ${shortModel(id).padEnd(24)} in ${fmtInt(value.inputTokens)} · out ${fmtInt(value.outputTokens)} · cache ${fmtInt(value.cacheReadTokens + value.cacheWriteTokens)}`,
				);
			}
		}
		return lines.join('\n');
	};

	/* ---------- /con: live context usage ---------- */
	/** Fill bar for the context percentage, 20 cells wide. */
	const contextBar = (percent: number): string => {
		const width = 20;
		const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
		return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
	};

	/** The host's live reading (`cmd.getContextUsage`), validated field by field. */
	const readLiveContext = (): {used?: number; limit?: number; percent?: number; available?: boolean} => {
		try {
			const raw = typeof cmd.getContextUsage === 'function' ? cmd.getContextUsage() : undefined;
			const record = asRecord(raw);
			const used = asOptionalCount(record.tokens);
			const limit = asOptionalCount(record.contextWindow);
			const percent = asOptionalCount(record.percent);
			if (used !== undefined || limit !== undefined) {
				return {used, limit, percent: percent !== undefined ? Math.min(100, percent) : undefined, available: true};
			}
		} catch {
			/* fall back to the event-derived reading below */
		}
		return {};
	};

	const liveModel = (): string | undefined => {
		try {
			const value = cmd.getModel?.();
			if (typeof value === 'string' && value) return value;
		} catch {
			/* pre-bind hosts may not answer */
		}
		return model ?? configuredModel();
	};

	const liveEffort = (modelId: string | undefined): string | undefined => {
		try {
			const value = cmd.getEffort?.();
			if (typeof value === 'string' && value) return value;
		} catch {
			/* pre-bind hosts may not answer */
		}
		if (effort) return effort;
		const meta = modelId ? catalog.get(modelId) : undefined;
		return meta?.efforts && meta.efforts.length > 0 ? 'default' : undefined;
	};

	/** Plain text (no ANSI) so the report survives an ACP transport unchanged. */
	const buildContextReport = (): string => {
		hydrateCatalog();
		const modelId = liveModel();
		const shownEffort = liveEffort(modelId);
		const header = `Context — ${modelId ?? 'unknown model'}${shownEffort ? ` · effort ${shownEffort}` : ''}`;
		const live = readLiveContext();
		const used = live.available ? live.used : ctxTokens;
		const limit = live.limit ?? (modelId ? catalog.get(modelId)?.ctx : undefined);
		if (used === undefined) {
			return [header, '', '  No current context measurement available yet.'].join('\n');
		}
		const percent =
			live.percent ??
			(typeof limit === 'number' && limit > 0 ? Math.max(0, Math.min(100, Math.round((used / limit) * 100))) : undefined);
		const row = (label: string, value: string): string => `  ${label.padEnd(8)}${value}`;
		const lines: string[] = [header, ''];
		lines.push(row('used', `${fmtInt(used)} tokens`));
		lines.push(row('source', live.available ? 'host context estimate' : 'last model request (may be stale)'));
		if (contextAfterCompaction) lines.push('  Note: this host reading may include pre-compaction usage until the next model request.');
		if (typeof limit === 'number' && limit > 0) {
			lines.push(row('window', `${fmtInt(limit)} tokens`));
			lines.push(row('free', `${fmtInt(Math.max(0, limit - used))} tokens (${Math.max(0, 100 - (percent ?? 0))}%)`));
			if (percent !== undefined) lines.push(row('fill', `${String(percent).padStart(3)}%  ${contextBar(percent)}`));
		} else {
			lines.push(row('window', 'unknown for this model'));
		}
		lines.push('', '  /com compacts the conversation · /tokens shows session totals');
		return lines.join('\n');
	};

	/* ---------- /com: compaction result ---------- */
	let manualCompaction: Record<string, unknown> | undefined;
	let awaitingCompaction = false;
	let contextAfterCompaction = false;
	cmd.on('compaction_outcome', (event: unknown) => {
		const outcome = asRecord(event);
		if (outcome.outcome === 'summarized') contextAfterCompaction = true;
		if (awaitingCompaction && outcome.trigger === 'manual') manualCompaction = outcome;
	});
	const buildCompactionMessage = (result: unknown, contextBefore?: number): string => {
		const record = asRecord(result);
		const outcome = manualCompaction;
		const beforeTokens = asOptionalCount(outcome?.tokensBefore);
		const afterTokens = asOptionalCount(outcome?.tokensAfter);
		if (outcome) {
			const status = outcome.outcome === 'summarized' ? 'Conversation summarized.'
				: outcome.outcome === 'too-small' ? 'No further summary was made: not enough older messages to summarize.'
				: outcome.outcome === 'failed' ? 'Compaction failed: the host could not produce a summary.'
				: `Compaction outcome: ${String(outcome.outcome ?? 'unknown')}.`;
			const lines = [status];
			if (beforeTokens !== undefined && afterTokens !== undefined)
				lines.push(`Estimated conversation messages: ${fmtInt(beforeTokens)} → ${fmtInt(afterTokens)} tokens.`);
			const afterContext = readLiveContext().used;
			if (contextBefore !== undefined && afterContext !== undefined)
				lines.push(`Host context reading: ${fmtInt(contextBefore)} → ${fmtInt(afterContext)} tokens.`);
			else if (afterContext !== undefined) lines.push(`Host context reading: ${fmtInt(afterContext)} tokens.`);
			lines.push('These use different accounting. The host reading may retain pre-compaction usage until the next model request; message estimates exclude other context.');
			return lines.join('\n');
		}
		const before = asOptionalCount(record.messagesBefore);
		const after = asOptionalCount(record.messagesAfter);
		const saved = asOptionalCount(record.tokensSaved);
		const counts =
			before !== undefined && after !== undefined ? `${fmtInt(before)} → ${fmtInt(after)} messages` : undefined;
		const lines: string[] = [];
		if (saved !== undefined && saved > 0) {
			lines.push(`Compacted conversation: ~${fmtInt(saved)} tokens freed${counts ? ` · ${counts}` : ''}.`);
		} else if (counts) {
			lines.push(`Compaction finished: no tokens freed · ${counts}.`);
		} else {
			return 'Compaction requested, but the host did not report an outcome. /con shows the host’s current context estimate when available.';
		}
		return lines.join('\n');
	};

	/* ---------- registrations ---------- */
	cmd.addFlag('showTokens', {
		type: 'boolean',
		default: true,
		description: 'Show token counts next to the context percentage in the footer',
	});

	cmd.addFlag('planGate', {
		type: 'boolean',
		default: true,
		description: 'Show plan files and ask approve/stop before implementing when the built-in plan review cannot',
	});

	cmd.hooks({
		onSessionStart: safe(() => {
			resetCounters();
			model = undefined;
			effort = undefined;
			effortSetAt = 0;
			ctxTokens = undefined;
			subagents = 0;
			permissionMode = undefined;
			gatedPlans.clear();
			explicitPlanReview = false;
			planStopped = false;
			seedFromSession();
			model = model ?? configuredModel();
			refreshEffort();
			pushStatus();
		}),
		onSessionEnd: safe(() => {
			persist();
			try {
				cmd.ui?.setStatus?.(null);
			} catch {
				/* ignore */
			}
		}),
		onRunEnd: safe(() => {
			persist();
		}),
		/**
		 * The built-in plan review only runs in `default`/`plan` mode, and ACP drops the
		 * plan text from review questions. When a plan file is written in any other mode,
		 * show it and ask before the model starts implementing.
		 */
		beforeToolCall: (payload: unknown) => {
			try {
				if (!planStopped) return undefined;
				const event = asRecord(payload);
				const toolName = typeof event.toolName === 'string' ? event.toolName : '';
				if (toolName !== 'write_file' && toolName !== 'edit_file' && toolName !== 'shell_command') return undefined;
				const input = asRecord(event.input);
				const rawPath = typeof input.file_path === 'string' ? input.file_path : '';
				// Further plan edits are allowed; implementation is not.
				if (rawPath && resolvePlanPath(rawPath, cmd.cwd ?? process.cwd())) return undefined;
				return {
					block: true,
					terminate: true,
					additionalContext:
						'The user stopped the run after reviewing the plan. Do not implement; wait for their direction.',
				};
			} catch {
				return undefined;
			}
		},
		afterToolCall: async (payload: unknown) => {
			try {
				const event = asRecord(payload);
				const toolName = typeof event.toolName === 'string' ? event.toolName : '';
				if (event.isError === true || subagents > 0) return undefined;
				if (toolName === 'exit_plan_mode' || toolName === 'plan_review') {
					explicitPlanReview = true;
					return undefined;
				}
				if (toolName !== 'write_file' && toolName !== 'edit_file') return undefined;
				if (cmd.getFlag('planGate') === false || explicitPlanReview) return undefined;
				const input = asRecord(event.input);
				const rawPath = typeof input.file_path === 'string' ? input.file_path : '';
				if (!rawPath) return undefined;
				const planPath = resolvePlanPath(rawPath, cmd.cwd ?? process.cwd());
				if (!planPath || gatedPlans.has(planPath)) return undefined;
				gatedPlans.add(planPath);
				const content = readPlanText(planPath);
				const body = content ?? '(could not read the plan file)';
				const clipped =
					body.length > 16000 ? `${body.slice(0, 16000)}\n\n… truncated; open the file for the full plan.` : body;
				try {
					cmd.ui?.notify?.(`Plan written to ${planPath}:\n\n${clipped}`, 'warning');
				} catch {
					/* notices are best-effort */
				}
				// The built-in plan review already asks at stop in these modes.
				if (permissionMode === 'default' || permissionMode === 'plan') return undefined;
				if (typeof cmd.ui?.select !== 'function') return undefined;
				const choice = await cmd.ui.select({
					title: 'Plan ready — approve implementation?',
					options: [
						{label: 'Approve — implement this plan', description: 'Continue and make the changes.'},
						{label: 'Stop — I want to review the plan', description: 'End the run so you can read or revise the plan.'},
					],
				});
				if (choice === 'Stop — I want to review the plan') {
					planStopped = true;
					return {
						terminate: true,
						additionalContext:
							'The user stopped the run after reviewing the plan. Do not implement; wait for their direction.',
					};
				}
				if (choice === 'Approve — implement this plan') {
					return {
						additionalContext: 'The user reviewed and approved the plan. Implement it now, following the plan.',
					};
				}
				return undefined;
			} catch {
				return undefined;
			}
		},
	});

	cmd.on(
		'model_request_start',
		safe((event: unknown) => {
			const record = asRecord(event);
			if (typeof record.model === 'string' && record.model) model = record.model;
			if (subagents === 0) {
				requestStartedAt = Date.now();
				streamStartedAt = undefined;
				streamChars = 0;
				liveTps = undefined;
			}
			refreshEffort();
			pushStatus();
		}),
	);

	cmd.on(
		'model_request_end',
		safe((event: unknown) => {
			const record = asRecord(event);
			const usage = readUsage(record);
			if (!usage) return;
			const requestModel = typeof record.model === 'string' && record.model ? record.model : model;
			accumulate(requestModel, usage);
			if (requestModel) model = requestModel;
			if (subagents === 0 && usage.inputTokens > 0) {
				ctxTokens = usage.inputTokens;
				contextAfterCompaction = false;
			}
			if (subagents === 0) {
				if (usage.outputTokens > 0) {
					const anchor = streamStartedAt ?? requestStartedAt;
					const elapsedMs = anchor !== undefined ? Date.now() - anchor : 0;
					if (elapsedMs >= MIN_RATE_MS) {
						const tps = usage.outputTokens / (elapsedMs / 1000);
						if (Number.isFinite(tps) && tps > 0 && tps < MAX_TPS) {
							lastTps = tps;
							genMs += elapsedMs;
							genTokens += usage.outputTokens;
						}
					}
				}
				if (usage.inputTokens > 0) {
					lastCacheHitPct = Math.min(100, Math.max(0, (usage.cacheReadTokens / usage.inputTokens) * 100));
				}
				requestStartedAt = undefined;
				streamStartedAt = undefined;
				streamChars = 0;
				liveTps = undefined;
			}
			pushStatus();
		}),
	);

	// Streaming deltas drive the live TPS estimate: chars/4 (the CLI's own estimator) over the
	// time since the first delta, so the footer shows a rate while the response is arriving.
	const noteDelta = (event: unknown): void => {
		if (subagents > 0) return;
		const record = asRecord(event);
		const delta =
			typeof record.delta === 'string' ? record.delta : typeof record.text === 'string' ? record.text : '';
		if (!delta) return;
		const now = Date.now();
		if (streamStartedAt === undefined) streamStartedAt = now;
		streamChars += delta.length;
		const anchor = streamStartedAt ?? requestStartedAt;
		const elapsedMs = anchor !== undefined ? now - anchor : 0;
		if (elapsedMs >= MIN_RATE_MS) {
			const tps = streamChars / CHARS_PER_TOKEN / (elapsedMs / 1000);
			if (Number.isFinite(tps) && tps > 0 && tps < MAX_TPS) liveTps = tps;
		}
		if (now - lastLivePaintAt >= LIVE_PAINT_MS) {
			lastLivePaintAt = now;
			pushStatus();
		}
	};

	cmd.on('text_delta', safe(noteDelta));
	cmd.on('thinking_delta', safe(noteDelta));

	cmd.on(
		'turn_end',
		safe(() => {
			totals.turns += 1;
			// Save per turn too: closing the terminal mid-run then loses at most one turn.
			persist();
		}),
	);

	cmd.on(
		'config_setting_changed',
		safe((event: unknown) => {
			const record = asRecord(event);
			const setting = typeof record.setting === 'string' ? record.setting : '';
			if (setting === 'model') {
				if (typeof record.value === 'string' && record.value) model = record.value;
				refreshEffort();
				pushStatus();
			} else if (setting === 'effort') {
				if (typeof record.value === 'string' && record.value) {
					effort = record.value;
					effortSetAt = Date.now();
				} else {
					effort = undefined;
					effortSetAt = 0;
				}
				pushStatus();
			}
		}),
	);

	cmd.on(
		'permission_mode_changed',
		safe((event: unknown) => {
			const mode = asRecord(event).mode;
			if (typeof mode === 'string' && mode) permissionMode = mode;
		}),
	);

	cmd.on(
		'run_start',
		safe(() => {
			gatedPlans.clear();
			explicitPlanReview = false;
			planStopped = false;
		}),
	);

	cmd.on(
		'subagent_start',
		safe(() => {
			subagents += 1;
		}),
	);

	cmd.on(
		'subagent_stop',
		safe(() => {
			subagents = Math.max(0, subagents - 1);
		}),
	);

	cmd.addCommand({
		name: 'tokens',
		description: "This session's token usage (input/output/cache), context fill, speed and cache hit rate",
		argumentHint: '[reset]',
		handler: (payload: unknown) => {
			try {
				const args = typeof asRecord(payload).args === 'string' ? String(asRecord(payload).args).trim().toLowerCase() : '';
				if (args === 'reset') {
					resetCounters();
					persist();
					return {message: 'Session token counters reset.'};
				}
				return {message: buildReport()};
			} catch (error) {
				return {message: `session-monitor: could not build the report (${error instanceof Error ? error.message : String(error)})`};
			}
		},
	});

	cmd.addCommand({
		name: 'con',
		description: 'Current context usage — tokens used, window size and fill percent (plain text, works over ACP)',
		handler: () => {
			try {
				return {message: buildContextReport()};
			} catch (error) {
				return {message: `session-monitor: could not read context usage (${error instanceof Error ? error.message : String(error)})`};
			}
		},
	});

	cmd.addCommand({
		name: 'com',
		description: 'Compact the conversation now — the /compact action, callable over ACP',
		handler: async () => {
			try {
				const compact = cmd.sessions?.compact;
				if (typeof compact !== 'function') {
					return {message: 'session-monitor: this host does not expose session compaction to mods.'};
				}
				manualCompaction = undefined;
				const contextBefore = readLiveContext().used;
				awaitingCompaction = true;
				const result = await compact();
				pushStatus();
				return {message: buildCompactionMessage(result, contextBefore)};
			} catch (error) {
				return {message: `session-monitor: compaction failed (${error instanceof Error ? error.message : String(error)}).`};
			} finally {
				awaitingCompaction = false;
			}
		},
	});
}
