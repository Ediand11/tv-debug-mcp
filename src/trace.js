import {closeSync, openSync, writeSync} from 'node:fs';
import {resolve} from 'node:path';

export const TRACE_CATEGORIES = [
	'devtools.timeline',
	'disabled-by-default-devtools.timeline',
	'disabled-by-default-devtools.timeline.frame',
	'blink.user_timing',
	'loading',
	'toplevel',
	'cc',
	'gpu',
	'v8',
	'v8.execute'
];

export const DEFAULT_BUFFER_MB = 40;
export const MAX_BUFFER_MB = 200;
export const LONG_TASK_MS = 50;

const BUCKET_BY_NAME = {
	FunctionCall: 'script',
	EvaluateScript: 'script',
	'v8.compile': 'script',
	'v8.compileModule': 'script',
	'v8.evaluateModule': 'script',
	'v8.run': 'script',
	'v8.callFunction': 'script',
	'V8.Execute': 'script',
	TimerFire: 'script',
	FireAnimationFrame: 'script',
	FireIdleCallback: 'script',
	EventDispatch: 'script',
	XHRReadyStateChange: 'script',
	XHRLoad: 'script',
	RunMicrotasks: 'script',
	RecalculateStyles: 'style',
	UpdateLayoutTree: 'style',
	ParseAuthorStyleSheet: 'style',
	Layout: 'layout',
	'WebViewImpl::layout': 'layout',
	UpdateLayerTree: 'layerTree',
	UpdateLayer: 'layerTree',
	Paint: 'paint',
	PrePaint: 'paint',
	PaintImage: 'paint',
	Layerize: 'paint',
	CompositeLayers: 'composite',
	ParseHTML: 'parse'
};
const SYNC_PHASES = new Set(['X', 'B', 'E', 'I', 'i']);
const BUCKETS = ['script', 'style', 'layout', 'layerTree', 'paint', 'composite', 'gc', 'parse'];

function bucketOf(name) {
	return BUCKET_BY_NAME[name] || (/GC|GarbageCollect/.test(name) ? 'gc' : null);
}

export async function startTrace(cdp, opts = {}) {
	const bufferMb = Math.min(MAX_BUFFER_MB, Math.max(1, Math.floor(opts.bufferMb || DEFAULT_BUFFER_MB)));
	const params = opts.legacy
		? {categories: TRACE_CATEGORIES.join(','), options: 'record-continuously'}
		: {
			transferMode: 'ReportEvents',
			traceConfig: {
				recordMode: 'recordContinuously',
				includedCategories: TRACE_CATEGORIES,
				traceBufferSizeInKb: bufferMb * 1024
			}
		};
	await cdp.call('Tracing.start', params);
	return {bufferMb: opts.legacy ? null : bufferMb, legacy: !!opts.legacy, startedAt: Date.now(), events: []};
}

export async function endTrace(cdp, state, opts) {
	let off = () => {};
	let timer = null;
	const done = new Promise((res) => {
		off = cdp.onEvent('Tracing.tracingComplete', (p) => res({complete: true, dataLoss: !!(p && p.dataLossOccurred)}));
		timer = setTimeout(() => res({complete: false, dataLoss: false}), opts.timeoutMs);
	});
	try {
		await cdp.call('Tracing.end');
		return await done;
	} finally {
		clearTimeout(timer);
		off();
	}
}

export function saveTrace(events, opts) {
	const path = opts.path
		? resolve(opts.path)
		: resolve(process.env.TMPDIR || '/tmp', `tv-trace-${opts.deviceId}-${opts.now}.json`);
	const fd = openSync(path, 'w');
	let bytes = 0;
	const put = (s) => {
		bytes += writeSync(fd, s);
	};
	try {
		put('{"traceEvents":[');
		for (let i = 0; i < events.length; i += 2000) {
			put((i ? ',' : '') + events.slice(i, i + 2000).map((e) => JSON.stringify(e)).join(','));
		}
		put(']}');
	} finally {
		closeSync(fd);
	}
	return {path, bytes};
}

const round = (us) => Math.round(us / 100) / 10;

function threadIntervals(events) {
	const threads = new Map();
	const names = new Map();
	const get = (e) => {
		const key = `${e.pid}:${e.tid}`;
		let t = threads.get(key);
		if (!t) {
			t = {key, spans: [], open: []};
			threads.set(key, t);
		}
		return t;
	};
	for (const e of events) {
		if (e.ph === 'M') {
			if (e.name === 'thread_name' && e.args) {
				names.set(`${e.pid}:${e.tid}`, e.args.name);
			}
			continue;
		}
		if (e.ph === 'X' && typeof e.dur === 'number') {
			get(e).spans.push({name: e.name, ts: e.ts, end: e.ts + e.dur, args: e.args});
		} else if (e.ph === 'B') {
			get(e).open.push({name: e.name, ts: e.ts, args: e.args});
		} else if (e.ph === 'E') {
			const t = get(e);
			const b = t.open.pop();
			if (b) {
				t.spans.push({name: b.name, ts: b.ts, end: e.ts, args: b.args});
			}
		}
	}
	for (const t of threads.values()) {
		t.name = names.get(t.key) || t.key;
		t.spans.sort((a, b) => a.ts - b.ts || b.end - a.end);
		const stack = [];
		for (const s of t.spans) {
			while (stack.length && stack[stack.length - 1].end <= s.ts) {
				stack.pop();
			}
			const parent = stack[stack.length - 1];
			s.self = s.end - s.ts;
			s.depth = stack.length;
			s.root = parent ? parent.root : s;
			if (parent) {
				parent.self -= Math.min(s.end, parent.end) - s.ts;
			}
			stack.push(s);
		}
	}
	return [...threads.values()];
}

export function summarizeTrace(events, opts = {}) {
	const topN = opts.topN || 5;
	let t0 = Infinity;
	let t1 = -Infinity;
	for (const e of events) {
		if (SYNC_PHASES.has(e.ph) && typeof e.ts === 'number' && e.ts > 0) {
			t0 = Math.min(t0, e.ts);
			t1 = Math.max(t1, e.ts + (e.dur || 0));
		}
	}
	if (t0 === Infinity) {
		return {windowMs: 0, events: events.length, main: null, threads: [], frames: {drawn: 0, worstGapMs: null}};
	}

	const threads = threadIntervals(events);
	const busy = (t) => t.spans.reduce((n, s) => n + (s.depth === 0 ? s.end - s.ts : 0), 0);
	const mappedSelf = (t) => t.spans.reduce((n, s) => n + (bucketOf(s.name) ? s.self : 0), 0);
	const main = threads.find((t) => t.name === 'CrRendererMain') ||
		threads.slice().sort((a, b) => mappedSelf(b) - mappedSelf(a))[0];

	let mainOut = null;
	if (main) {
		const buckets = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
		const perRoot = new Map();
		for (const s of main.spans) {
			const b = bucketOf(s.name);
			if (!b) {
				continue;
			}
			buckets[b] += s.self;
			const r = perRoot.get(s.root) || {};
			r[b] = (r[b] || 0) + s.self;
			perRoot.set(s.root, r);
		}
		const busyUs = busy(main);
		const mapped = Object.values(buckets).reduce((a, b) => a + b, 0);
		const long = main.spans
			.filter((s) => s.depth === 0 && s.end - s.ts >= LONG_TASK_MS * 1000)
			.sort((a, b) => (b.end - b.ts) - (a.end - a.ts));
		mainOut = {
			thread: main.name,
			busyMs: round(busyUs),
			ms: {...Object.fromEntries(BUCKETS.map((b) => [b, round(buckets[b])])), other: round(Math.max(0, busyUs - mapped))},
			longTasks: {
				count: long.length,
				totalMs: round(long.reduce((n, s) => n + s.end - s.ts, 0)),
				top: long.slice(0, topN).map((s) => {
					const r = perRoot.get(s) || {};
					const mostly = Object.keys(r).sort((a, b) => r[b] - r[a])[0] || null;
					return {atMs: round(s.ts - t0), ms: round(s.end - s.ts), mostly};
				})
			}
		};
	}

	const others = threads
		.filter((t) => t !== main)
		.map((t) => ({name: t.name, busyMs: round(busy(t))}))
		.filter((t) => t.busyMs > 0);
	const merged = new Map();
	for (const t of others) {
		const name = t.name.replace(/\d+\/?\d*$/, '');
		merged.set(name, (merged.get(name) || 0) + t.busyMs);
	}

	const draws = events.filter((e) => e.name === 'DrawFrame' && e.ph !== 'M').map((e) => e.ts).sort((a, b) => a - b);
	let worstGap = null;
	for (let i = 1; i < draws.length; i++) {
		worstGap = Math.max(worstGap || 0, draws[i] - draws[i - 1]);
	}

	const keydown = events.find((e) => e.name === 'EventDispatch' && e.args && e.args.data && e.args.data.type === 'keydown');

	return {
		windowMs: round(t1 - t0),
		events: events.length,
		...(keydown ? {keydownAtMs: round(keydown.ts - t0)} : {}),
		main: mainOut,
		threads: [...merged.entries()]
			.map(([name, ms]) => ({name, busyMs: Math.round(ms * 10) / 10}))
			.sort((a, b) => b.busyMs - a.busyMs)
			.slice(0, 6),
		frames: {drawn: draws.length, worstGapMs: worstGap == null ? null : round(worstGap)}
	};
}
