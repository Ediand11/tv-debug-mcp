// Chrome tracing for tv_trace: record a real DevTools trace on the device, save it as
// `{traceEvents: […]}` (the format the Performance panel and trace-engine-cli read), and hand it
// to trace-engine-cli for the summaries a flat CPU profile cannot give — Core Web Vitals, long
// tasks with call trees, rAF/timer churn, layout shifts, the request waterfall.
//
// `Tracing` is a younger domain than `Profiler`: it is there on PC, webOS 4+ and Tizen 5.5+, and
// it is NOT there on Chrome 38 (webOS 3) or the WebKit Tizen 2.4 — on those tv_profile is the
// only recording there is, and this module says so instead of leaking a protocol error.
//
// The trace never goes back to the model: tens of megabytes of low-level events are written to
// disk, and the answer is the path plus counts. Analysis is a second, optional step.

import {execFile} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {promisify} from 'node:util';

const execFileP = promisify(execFile);

/** Enough for LCP/CLS/long tasks/network; screenshots and full V8 sampling are left out on purpose. */
export const TRACE_CATEGORIES = [
	'devtools.timeline',
	'disabled-by-default-devtools.timeline',
	'disabled-by-default-devtools.timeline.frame',
	'disabled-by-default-devtools.timeline.invalidationTracking',
	'blink',
	'blink.user_timing',
	'cc',
	'gpu',
	'loading',
	'renderer.scheduler',
	'toplevel',
	'v8',
	'v8.execute',
	'viz'
].join(',');

/** Chrome's own default. A weak TV die has no business buffering more. */
export const DEFAULT_BUFFER_MB = 40;
/** The buffer is a ring: when it fills, the oldest events are dropped and the trace says so. */
export const MAX_BUFFER_MB = 200;

const TRACING_COMPLETE_TIMEOUT_MS = 120000;
const ANALYZE_TIMEOUT_MS = 180000;
const ANALYZE_CAP_BYTES = 8000;

/**
 * Is the `Tracing` domain missing on this engine — as opposed to the call failing for another
 * reason (buffer, timeout, dropped connection)?
 * @param {Error & {protocolCode?: number}} err
 */
export function isTracingUnsupported(err) {
	return err.protocolCode === -32601 || /not (implemented|supported|found)/i.test(err.message || '');
}

/**
 * `Tracing.start`. Callers keep the returned state for `stopTrace` and hold the same CDP
 * connection until then — a reattach means a different renderer and the recording dies with it.
 * @param {{call: function(string, object=, number=): Promise<object>}} cdp
 * @param {{categories?: string, bufferMb?: number}} [opts]
 */
export async function startTrace(cdp, opts = {}) {
	const bufferMb = Math.min(MAX_BUFFER_MB, Math.max(1, Math.floor(opts.bufferMb || DEFAULT_BUFFER_MB)));
	const categories = (opts.categories || TRACE_CATEGORIES).trim();
	if (!categories) {
		throw new Error('categories must not be empty — pass a comma-separated CDP category list, or omit it');
	}
	await cdp.call('Tracing.start', {
		// ReportEvents delivers Tracing.dataCollected over the socket; ReturnAsStream needs
		// IO.read and is not worth the round-trips over an ares inspector.
		transferMode: 'ReportEvents',
		// Categories go in traceConfig only: CDP refuses `categories` alongside `traceConfig`.
		traceConfig: {
			included_categories: categories.split(','),
			excluded_categories: ['*'],
			record_mode: 'ring',
			trace_buffer_size_in_kb: bufferMb * 1024
		}
	});
	return {categories, bufferMb, startedAt: Date.now(), events: []};
}

/**
 * `Tracing.end` and the collected events written to `path`.
 *
 * `Tracing.dataCollected` arrives in chunks while the recording runs; the chunks were registered
 * by `startTrace`'s caller through `onCollect` (see `DeviceSession.traceStart`) because a handler
 * installed after the fact misses everything that already happened.
 * @param {{call: function(string, object=, number=): Promise<object>}} cdp
 * @param {{startedAt: number, events: Array<object>, categories: string, bufferMb: number}} state
 * @param {{path?: string, deviceId: string, now: number, onCollect: function(function(): void): void}} opts
 */
export async function stopTrace(cdp, state, opts) {
	const {events} = state;
	let complete = false;
	let completeTimer = null;
	const done = new Promise((res) => {
		opts.onCollect(() => {
			complete = true;
			res();
		});
		completeTimer = setTimeout(() => res(), TRACING_COMPLETE_TIMEOUT_MS);
	});

	try {
		await cdp.call('Tracing.end');
		await done;
	} finally {
		if (completeTimer) {
			clearTimeout(completeTimer);
		}
	}

	const durationMs = Date.now() - state.startedAt;
	const warnings = [];
	if (!complete) {
		warnings.push(`Tracing.tracingComplete did not arrive in ${TRACING_COMPLETE_TIMEOUT_MS}ms — the trace may be cut short`);
	}
	if (!events.length) {
		warnings.push('the recording contains no events — was anything happening between start and stop? check that the page is attached');
	}

	const outPath = opts.path
		? resolve(opts.path)
		: resolve(process.env.TMPDIR || '/tmp', `tv-trace-${opts.deviceId}-${opts.now}.json`);
	const json = JSON.stringify({traceEvents: events});
	writeFileSync(outPath, json);

	return {
		ok: true,
		path: outPath,
		bytes: Buffer.byteLength(json),
		events: events.length,
		durationMs,
		categories: state.categories,
		bufferMb: state.bufferMb,
		...(warnings.length ? {warning: warnings.join('; ')} : {})
	};
}

/**
 * Run `trace-engine-cli` over a saved trace and return its summary.
 *
 * The CLI is not bundled: it wraps Chrome DevTools' own trace engine (@paulirish/trace_engine)
 * and is fetched by npx on first use. Bundling it would pin a fast-moving preview build inside
 * this server.
 * @param {string} path
 * @param {{command?: string, timeRange?: string, format?: 'toon'|'md'}} [opts]
 */
export async function analyzeTrace(path, opts = {}) {
	const file = resolve(path);
	const args = ['-y', 'trace-engine-cli@latest'];
	if (opts.command) {
		args.push(opts.command);
	}
	args.push(file);
	if (opts.timeRange) {
		args.push('--time-range', opts.timeRange);
	}
	if (opts.format) {
		args.push('--format', opts.format);
	}

	let stdout = '';
	let warning;
	try {
		const res = await execFileP('npx', args, {timeout: ANALYZE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024});
		stdout = res.stdout || '';
	} catch (e) {
		if (e.code === 'ENOENT') {
			throw new Error('npx not found — trace-engine-cli is fetched over npx, install Node/npx or analyze the file in DevTools → Performance');
		}
		// A non-zero exit still prints the parse error that explains it.
		stdout = e.stdout || '';
		warning = (e.stderr || e.message || '').trim().split('\n').slice(-3).join(' ');
		if (!stdout) {
			throw new Error(`trace-engine-cli failed: ${warning || e.message}`);
		}
	}

	const text = stdout.trim();
	const cut = Buffer.byteLength(text) > ANALYZE_CAP_BYTES;
	const shown = cut ? Buffer.from(text, 'utf8').subarray(0, ANALYZE_CAP_BYTES).toString('utf8') : text;

	return {
		ok: true,
		path: file,
		command: opts.command || 'overview',
		...(opts.timeRange ? {timeRange: opts.timeRange} : {}),
		text: shown,
		...(cut ? {truncated: true, hint: 'narrow with timeRange or a specific command (tasks/profile/insights/network)'} : {}),
		...(warning ? {warning} : {})
	};
}
