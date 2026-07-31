// Per-device live session: an adapter (sdb/ares) + a persistent CDP connection whose
// console/exception buffers accumulate from launch. The server keeps one of these per
// device id and reuses it across tool calls.
//
// Two locks, deliberately separate:
//   _lifecycleLock — serialises connect/relaunch/reload. Without it two concurrent tool
//                    calls both kill-and-launch the app and leak one CDP connection.
//   _opLock        — held by a whole batched run (tv_sequence) so nothing interleaves with
//                    it. It must NOT be the lifecycle lock, or an auto-reconnect inside a
//                    sequence step would deadlock against the sequence itself.

import {createWriteStream, unlinkSync} from 'node:fs';
import {resolve} from 'node:path';

import {TizenAdapter} from './adapters/tizen.js';
import {WebosAdapter} from './adapters/webos.js';
import {PcAdapter} from './adapters/pc.js';
import {SyntheticInput} from './input/synthetic.js';
import {TrustedInput} from './input/trusted.js';
import {CdpSession, resolvePageWs, sleep, isUnsupportedMethod} from './cdp.js';
import {resolveKey} from './keymaps.js';
import {focusSnapshotJs, videoStateJs} from './inject.js';
import {freePort} from './ports.js';
import {loadAppProfile, requireMenu} from './appprofile.js';
import {stateJs, focusSignatureJs, focusMatchesJs, menuItemsJs} from './state.js';
import {pollUntil} from './wait.js';
import {summarizeProfile, applySourceMap, saveProfile} from './profile.js';
import {summarizeHeapSnapshot} from './heap.js';
import {metricsToMap, metricsDiff, windowSecondsOf} from './metrics.js';

/** A big profile off a slow TV takes far longer to serialise than a normal CDP round-trip. */
const PROFILE_STOP_TIMEOUT_MS = 60000;
/** A forced GC on a weak TV with a full heap is not an 8-second operation. */
const GC_TIMEOUT_MS = 30000;
/**
 * A heap snapshot is a full GC plus serialising the whole heap through the socket in
 * thousands of chunks. On a TV with a 100-300MB heap that legitimately takes a minute.
 */
const HEAP_SNAPSHOT_TIMEOUT_MS = 120000;
/** Chunks can keep arriving after `takeHeapSnapshot` answers — wait out the quiet. */
const HEAP_DRAIN_QUIET_MS = 400;
const HEAP_DRAIN_MAX_MS = 15000;

/**
 * Flush and close a write stream, waiting for the OS to really have the bytes — the summary
 * parser reads the file back immediately afterwards.
 * @param {import('node:fs').WriteStream} stream
 * @return {Promise<void>}
 */
function closeStream(stream) {
	return new Promise((res, rej) => {
		stream.end((e) => (e ? rej(e) : res()));
	});
}

/**
 * Short human label for a sequence step, for the per-step report.
 * @param {object} step
 * @return {string}
 */
function stepLabel(step) {
	const key = Object.keys(step)[0];
	const value = step[key];
	const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
	return `${key}: ${rendered}`.slice(0, 120);
}

function makeAdapter(cfg, log) {
	if (cfg.platform === 'tizen') {
		return new TizenAdapter({host: cfg.host, sdbPort: cfg.sdbPort, cliTarget: cfg.cliTarget, log});
	}
	if (cfg.platform === 'webos') {
		return new WebosAdapter({device: cfg.device, log});
	}
	if (cfg.platform === 'pc') {
		return new PcAdapter({chromePath: cfg.chromePath, profileDir: cfg.profileDir, chromeArgs: cfg.chromeArgs, log});
	}
	throw new Error(`unsupported platform "${cfg.platform}" for device "${cfg.id}"`);
}

/**
 * Which key-injection strategy this device uses.
 *
 * TVs have no choice — the CDP Input domain is unreliable there and the apps read legacy
 * keyCodes. A local Chrome defaults to trusted events (closer to a real user), but can be
 * pinned to synthetic with `"inputMode": "synthetic"` to run the exact same event path as
 * the TV — a parity run. There is deliberately NO automatic fallback between the two: a
 * silent switch would make a green browser run mean something different from one run to
 * the next.
 * @param {import('./config.js').DeviceConfig} cfg
 */
function makeInput(cfg) {
	if (cfg.platform === 'pc' && cfg.inputMode !== 'synthetic') {
		return new TrustedInput();
	}
	return new SyntheticInput();
}

/**
 * Operations a device really supports, straight from its adapter — so `tv_devices` can
 * advertise the truth and unsupported calls fail loudly instead of pretending.
 * @param {import('./config.js').DeviceConfig} cfg
 * @return {object}
 */
export function deviceCapabilities(cfg) {
	try {
		const adapter = makeAdapter(cfg, () => {});
		return {...adapter.capabilities, inputMode: makeInput(cfg).mode};
	} catch (e) {
		return {error: e.message};
	}
}

export class DeviceSession {
	/**
	 * @param {import('./config.js').DeviceConfig} cfg
	 * @param {Function} log
	 */
	constructor(cfg, log) {
		this.cfg = cfg;
		this._log = log;
		this.adapter = makeAdapter(cfg, log);
		this.input = makeInput(cfg);
		/** Selectors and menu layout of the app under test — see apps/<id>.json. */
		this.profile = loadAppProfile(cfg.app);
		/** @type {?CdpSession} */
		this.cdp = null;
		this.page = null;
		/** Local TCP port of the active forward (allocated on first connect). */
		this.localPort = cfg.localPort || null;
		this._everConnected = false;
		/**
		 * Live CPU recording, if any. The CdpSession instance is kept, not just a flag: a
		 * silent reattach gives us a NEW V8 with no recording in it (see profileStop).
		 * @type {?{startedAt: number, cdp: CdpSession, samplingIntervalUs: number}}
		 */
		this._profiling = null;
		/** Set when a recording died with its connection — kept only to explain the loss. */
		this._profilingLost = false;
		/**
		 * The CdpSession `Performance.enable` was called on — not a boolean. A reattach gives a
		 * new inspector session with the domain disabled again, and comparing instances re-enables
		 * it without any extra bookkeeping.
		 * @type {?CdpSession}
		 */
		this._metricsEnabledFor = null;
		this._lifecycleLock = Promise.resolve();
		this._opLock = Promise.resolve();
	}

	get platform() {
		return this.cfg.platform;
	}

	/**
	 * @template T
	 * @param {'_lifecycleLock'|'_opLock'} which
	 * @param {function(): Promise<T>} fn
	 * @return {Promise<T>}
	 */
	async _locked(which, fn) {
		const prev = this[which];
		let release;
		this[which] = new Promise((r) => {
			release = r;
		});
		await prev.catch(() => {});
		try {
			return await fn();
		} finally {
			release();
		}
	}

	/**
	 * Run `fn` with no other batched run interleaving. Used by tv_sequence.
	 * @template T
	 * @param {function(): Promise<T>} fn
	 * @return {Promise<T>}
	 */
	withOperationLock(fn) {
		return this._locked('_opLock', fn);
	}

	/**
	 * Ensure the app is debug-launched and CDP is connected.
	 * - reload: reload the page in place (same process, keeps localStorage). Only meaningful
	 *   for an already-live connection — a fresh launch is already a clean start.
	 * - relaunch: drop the CDP connection and do a fresh kill+debug-launch.
	 * - attach: don't kill a running instance; reuse its live inspector.
	 * @param {{reload?: boolean, relaunch?: boolean, attach?: boolean}} [opts]
	 */
	ensureConnected(opts = {}) {
		return this._locked('_lifecycleLock', () => this._ensureConnectedLocked(opts));
	}

	async _ensureConnectedLocked(opts) {
		if (this.cdp && this.cdp.isOpen && !opts.relaunch) {
			if (opts.reload) {
				await this._reload();
			}
			return this.page;
		}

		if (this.cdp) {
			this.cdp.close();
			this.cdp = null;
			this.page = null;
			// The recording lived in the V8 we just dropped. Forget it here so a later
			// profileStart is not refused by a flag pointing at a dead connection — but
			// remember that it existed, so `stop` can say what really happened.
			if (this._profiling) {
				this._profiling = null;
				this._profilingLost = true;
			}
			this._metricsEnabledFor = null;
		}
		if (!this.localPort) {
			this.localPort = await freePort();
		}

		const inspector = await this.adapter.acquireEndpoint(this.cfg, {
			localPort: this.localPort,
			attach: opts.attach,
			relaunch: opts.relaunch
		});
		const wsUrl = inspector.wsUrl || (await resolvePageWs(inspector.httpBase));
		const cdp = new CdpSession(wsUrl);
		await cdp.connect();
		this.cdp = cdp;
		this._everConnected = true;
		// Platform-specific work that needs a live CDP session (pc: kill the module cache,
		// then navigate to the dev server).
		if (this.adapter.afterConnect) {
			await this.adapter.afterConnect(cdp, this.cfg, inspector);
		}

		const info = await cdp.evaluate('({href: location.href, title: document.title})').catch(() => ({}));
		this.page = {
			wsUrl,
			...info,
			devicePort: inspector.devicePort,
			localPort: this.localPort,
			freshLaunch: inspector.freshLaunch
		};
		if (opts.reload && inspector.freshLaunch) {
			// Reloading an app that was launched a second ago just throws away its boot.
			this.page.reloadSkipped = 'fresh launch is already a clean start';
		} else if (opts.reload) {
			await this._reload();
		}
		return this.page;
	}

	/** Reload in place and wait for the load event instead of guessing with a sleep. */
	async _reload() {
		this._log('reloading page via CDP');
		const loaded = this.cdp.waitForLoad(20000);
		await this.cdp.evaluate('location.reload()', {awaitPromise: false});
		const res = await loaded;
		if (!res.loaded) {
			this._log('reload: no load event within 20s (engine may not report it)');
		}
		return res;
	}

	/**
	 * The CDP handle for an operation. If the TV dropped the socket, try exactly one
	 * reattach before failing — the old code failed every tool until a manual tv_launch.
	 * @return {Promise<CdpSession>}
	 */
	async _cdp() {
		if (this.cdp && this.cdp.isOpen) {
			return this.cdp;
		}
		if (!this._everConnected) {
			throw new Error(`device "${this.cfg.id}" is not launched — call tv_launch first`);
		}
		this._log('CDP connection is gone — reattaching once');
		await this.ensureConnected({attach: true});
		if (!this.cdp || !this.cdp.isOpen) {
			throw new Error(`device "${this.cfg.id}" lost its CDP connection and could not reattach — run tv_launch`);
		}
		return this.cdp;
	}

	/**
	 * Dispatch a key. For a long-press, hold = keydown, wait durationMs, keyup.
	 * For a short press, keydown+keyup back to back. `repeat` fires the whole press N times.
	 * @param {string|number} keyName
	 * @param {{durationMs?: number, repeat?: number, intervalMs?: number}} [opts]
	 */
	async press(keyName, opts = {}) {
		const cdp = await this._cdp();
		const spec = resolveKey(this.platform, keyName);
		const repeat = Math.max(1, Math.floor(opts.repeat || 1));
		const interval = opts.intervalMs != null ? Math.max(0, Math.floor(opts.intervalMs)) : 250;
		const hold = Math.max(0, Math.floor(opts.durationMs || 0));
		const before = await this.focus().catch(() => null);
		for (let i = 0; i < repeat; i++) {
			await this.input.keyDown(cdp, spec);
			if (hold > 0) {
				await sleep(hold);
			}
			await this.input.keyUp(cdp, spec);
			if (i < repeat - 1) {
				await sleep(interval);
			}
		}
		const after = await this.focusSettled(before).catch((e) => 'focus-read-failed: ' + e.message);
		return {
			key: String(keyName), keyCode: spec.code, repeat, holdMs: hold, inputMode: this.input.mode,
			focusedBefore: before, focusedAfter: after, focusChanged: before !== after
		};
	}

	async focus() {
		const cdp = await this._cdp();
		return cdp.evaluate(focusSnapshotJs(this.profile.focus));
	}

	/** Structured snapshot: url, title, visible scenes, focused element, popups, counts. */
	async state() {
		const cdp = await this._cdp();
		return cdp.evaluate(stateJs(this.profile));
	}

	/** Compact focus signature — used to detect movement and loops. */
	async focusSignature() {
		const cdp = await this._cdp();
		return cdp.evaluate(focusSignatureJs(this.profile));
	}

	/**
	 * Focus after an action, once it has settled.
	 *
	 * TV navigation is asynchronous — the app moves focus on the next frame, and lists
	 * animate. Reading focus straight after `keyup` reports the PREVIOUS tile, which made
	 * every press look like it did nothing. So: wait for focus to differ from `before`
	 * (or give up), then wait for it to stop changing.
	 * @param {?string} before focus snapshot taken before the action
	 * @param {{changeTimeoutMs?: number, stableMs?: number, intervalMs?: number}} [opts]
	 * @return {Promise<string>}
	 */
	async focusSettled(before, opts = {}) {
		const cdp = await this._cdp();
		const js = focusSnapshotJs(this.profile.focus);
		const changeTimeout = opts.changeTimeoutMs != null ? opts.changeTimeoutMs : 1200;
		const stableMs = opts.stableMs != null ? opts.stableMs : 250;
		const interval = opts.intervalMs != null ? opts.intervalMs : 100;

		let current = await cdp.evaluate(js);
		const changeDeadline = Date.now() + changeTimeout;
		while (current === before && Date.now() < changeDeadline) {
			await sleep(interval);
			current = await cdp.evaluate(js);
		}
		let stableSince = Date.now();
		while (Date.now() - stableSince < stableMs) {
			await sleep(interval);
			const next = await cdp.evaluate(js);
			if (next !== current) {
				current = next;
				stableSince = Date.now();
			}
		}
		return current;
	}

	async videoState(sampleGapMs = 600) {
		const cdp = await this._cdp();
		const gap = Number(sampleGapMs) || 600;
		return cdp.evaluate(videoStateJs(gap), {awaitPromise: true, timeoutMs: gap + 5000});
	}

	async evaluate(expression, awaitPromise) {
		const cdp = await this._cdp();
		return cdp.evaluate(expression, {awaitPromise});
	}

	/**
	 * Start a JS CPU sampling recording.
	 *
	 * `Profiler` is the one perf domain that exists all the way down to Chrome 38, which is why
	 * it — and not `Performance.getMetrics` or `Tracing` — is what the park gets profiled with.
	 * Metrics ride along where the engine has them, but their absence must never cost the
	 * recording: on Chrome 38 the profile is the whole point and metrics are the bonus.
	 * @param {{samplingIntervalUs?: number, collectGarbage?: boolean}} [opts]
	 */
	async profileStart(opts = {}) {
		if (this._profiling) {
			const heldMs = Date.now() - this._profiling.startedAt;
			throw new Error(`profiling already in progress (started ${heldMs}ms ago) — call tv_profile action:stop first`);
		}
		const cdp = await this._cdp();
		this._profilingLost = false;
		const interval = Math.min(1000000, Math.max(50, Math.floor(opts.samplingIntervalUs || 1000)));
		const warnings = [];

		// Before Profiler.start, deliberately: enabling the Performance domain and reading it
		// takes CDP round-trips, and anything done after `start` lands inside the recording.
		const metricsBefore = await this._metricsOn(cdp, {collectGarbage: opts.collectGarbage})
			.catch((e) => {
				warnings.push(`metrics unavailable, CPU profile unaffected: ${e.message}`);
				return null;
			});
		if (metricsBefore && metricsBefore.warnings) {
			warnings.push(...metricsBefore.warnings);
		}

		await this._profilerCall(cdp, 'Profiler.enable');
		// Engines that don't take the interval still profile, just at their own rate — and the
		// summary derives the real interval from the recording anyway.
		let intervalApplied = true;
		try {
			await cdp.call('Profiler.setSamplingInterval', {interval});
		} catch (e) {
			if (!isUnsupportedMethod(e)) {
				throw e;
			}
			intervalApplied = false;
		}
		await this._profilerCall(cdp, 'Profiler.start');

		this._profiling = {startedAt: Date.now(), cdp, samplingIntervalUs: interval, metricsBefore};
		return {
			ok: true,
			startedAt: this._profiling.startedAt,
			samplingIntervalUs: interval,
			intervalApplied,
			metrics: metricsBefore ? metricsBefore.metrics : null,
			...(warnings.length ? {warning: warnings.join('; ')} : {})
		};
	}

	/**
	 * Stop the recording, write the raw `.cpuprofile` and return a summary of it.
	 * @param {{path?: string, sourceMap?: string, topN?: number, collectGarbage?: boolean}} [opts]
	 */
	async profileStopAndSave(opts = {}) {
		if (!this._profiling) {
			if (this._profilingLost) {
				this._profilingLost = false;
				throw new Error('the app was relaunched or the connection dropped during profiling, profile discarded — start again');
			}
			throw new Error('no profiling in progress — call tv_profile action:start first');
		}
		const started = this._profiling;
		const cdp = await this._cdp().catch((e) => {
			this._profiling = null;
			throw new Error(`connection lost during profiling, profile discarded — start again (${e.message})`);
		});
		if (cdp !== started.cdp) {
			// A reattach means a different V8: the recording died with the old one, and
			// Profiler.stop here would return an empty or unrelated profile. Say so instead of
			// handing back a lie. (_cdp() normally clears the flag before we get here — this is
			// the backstop for any other path that swaps the connection.)
			this._profiling = null;
			throw new Error('connection lost during profiling, profile discarded — start again');
		}

		let profile;
		try {
			const res = await cdp.call('Profiler.stop', {}, PROFILE_STOP_TIMEOUT_MS);
			profile = res && res.profile;
		} finally {
			this._profiling = null;
			await cdp.call('Profiler.disable').catch(() => {});
		}
		const durationMs = Date.now() - started.startedAt;
		const warnings = [];

		// After Profiler.disable, for the same reason the opening snapshot is taken before start:
		// these round-trips have no business being inside the window they describe.
		const metricsAfter = await this._metricsOn(cdp, {collectGarbage: opts.collectGarbage})
			.catch((e) => {
				warnings.push(`metrics unavailable, CPU profile unaffected: ${e.message}`);
				return null;
			});
		if (metricsAfter && metricsAfter.warnings) {
			warnings.push(...metricsAfter.warnings);
		}
		let metrics = null;
		if (started.metricsBefore && metricsAfter) {
			const diff = metricsDiff(started.metricsBefore.metrics, metricsAfter.metrics);
			metrics = {
				windowSec: windowSecondsOf(diff),
				collectedGarbage: !!opts.collectGarbage,
				values: diff
			};
		} else if (metricsAfter) {
			// Only the closing reading survived — a diff would be a lie, the numbers still aren't.
			warnings.push('no opening metrics reading, only the final absolute values are reported');
			metrics = {windowSec: null, collectedGarbage: !!opts.collectGarbage, after: metricsAfter.metrics};
		}

		const saved = saveProfile(profile, {path: opts.path, deviceId: this.cfg.id, now: Date.now()});
		const summary = summarizeProfile(profile, {topN: opts.topN});
		if (opts.sourceMap) {
			const mapped = applySourceMap(summary, opts.sourceMap);
			if (!mapped.ok) {
				warnings.push(mapped.warning);
			} else if (mapped.mapped === 0) {
				warnings.push('source map read, but none of the top frames were in it — is it the map of the build on the device?');
			}
		}
		if (summary.format === 'legacy') {
			warnings.push('legacy Chrome 38 profile format — modern DevTools may refuse to load the file; the summary is still valid');
		}
		if (summary.sampleCount === 0) {
			warnings.push('the recording contains no samples — was anything happening between start and stop?');
		}
		return {
			ok: true,
			path: saved.path,
			bytes: saved.bytes,
			durationMs,
			format: summary.format,
			summary,
			metrics,
			...(warnings.length ? {warning: warnings.join('; ')} : {})
		};
	}

	/**
	 * A Profiler call whose absence means "this engine cannot profile" — turn the raw protocol
	 * error into something a human can act on.
	 * @param {CdpSession} cdp
	 * @param {string} method
	 */
	async _profilerCall(cdp, method) {
		try {
			return await cdp.call(method);
		} catch (e) {
			if (isUnsupportedMethod(e)) {
				throw new Error(`profiling not supported on this engine (${this.cfg.engine || this.cfg.platform}): ${method} — ${e.message}`);
			}
			throw e;
		}
	}

	/**
	 * One `Performance.getMetrics` reading: heap bytes, DOM node and listener counts, layout and
	 * style recalc counters, cumulative Duration counters.
	 *
	 * Standalone this is a snapshot; two of them around a scenario are what turn "the app feels
	 * heavier after browsing" into a number. Needs Chromium 60+ — on Chrome 38 (webos3) the whole
	 * Performance domain is missing and this throws, deliberately: `performance.memory` is
	 * quantized there and would answer with a fake steady number instead of an honest refusal.
	 * @param {{collectGarbage?: boolean}} [opts]
	 */
	async metricsSnapshot(opts = {}) {
		const cdp = await this._cdp();
		return this._metricsOn(cdp, opts);
	}

	/**
	 * @param {CdpSession} cdp the connection to read on — passed explicitly so the profiler
	 *   reads the SAME session it is recording on, never one swapped in by a reattach
	 * @param {{collectGarbage?: boolean}} [opts]
	 * @return {Promise<{at: number, metrics: Object<string, *>, warnings?: Array<string>}>}
	 */
	async _metricsOn(cdp, opts = {}) {
		const warnings = [];
		await this._enableMetrics(cdp);
		if (opts.collectGarbage) {
			// Default off on purpose: a forced GC is a pause, and a pause inside a CPU recording
			// on a weak TV distorts both the profile and what the app does next. Worth it only
			// when hunting a leak, where uncollected garbage is exactly what fakes the growth.
			try {
				await cdp.call('HeapProfiler.collectGarbage', {}, GC_TIMEOUT_MS);
			} catch (e) {
				warnings.push(`collectGarbage failed (${e.message}) — the numbers still include garbage not yet collected`);
			}
		}
		let res;
		try {
			res = await cdp.call('Performance.getMetrics');
		} catch (e) {
			throw this._metricsUnsupported(e, 'Performance.getMetrics');
		}
		const metrics = metricsToMap(res && res.metrics);
		if (!Object.keys(metrics).length) {
			warnings.push('the engine reported an empty metric list');
		}
		return {at: Date.now(), metrics, ...(warnings.length ? {warnings} : {})};
	}

	/**
	 * `Performance.enable` once per connection — getMetrics on a disabled domain answers with
	 * nothing on some engines instead of failing.
	 * @param {CdpSession} cdp
	 */
	async _enableMetrics(cdp) {
		if (this._metricsEnabledFor === cdp) {
			return;
		}
		try {
			await cdp.call('Performance.enable');
		} catch (e) {
			throw this._metricsUnsupported(e, 'Performance.enable');
		}
		this._metricsEnabledFor = cdp;
	}

	/**
	 * @param {Error} e
	 * @param {string} method
	 * @return {Error}
	 */
	_metricsUnsupported(e, method) {
		if (isUnsupportedMethod(e)) {
			return new Error(
				`metrics not supported on this engine (${this.cfg.engine || this.cfg.platform}): ${method} — ` +
				`${e.message}. The Performance domain needs Chromium 60+; tv_profile start/stop still records the CPU profile.`
			);
		}
		return e;
	}

	/**
	 * Take a full heap snapshot and write it where DevTools can load it (Memory -> Load).
	 *
	 * `Performance.getMetrics` says WHAT grew (JSHeapUsedSize, Nodes); this says WHO — which
	 * constructors gained objects, and how many detached DOM nodes are still being retained.
	 *
	 * The snapshot is streamed: the engine sends it as thousands of `addHeapSnapshotChunk`
	 * events, which are appended to the file as they land. Buffering a 300MB heap in a string
	 * first would be a second copy of the TV's entire heap inside this process.
	 * @param {{path?: string, topN?: number, timeoutMs?: number}} [opts]
	 */
	heapSnapshot(opts = {}) {
		// Under the operation lock: a snapshot is a long V8 pause, and a tv_sequence step
		// landing in the middle of it would be timing the pause, not the app.
		return this.withOperationLock(() => this._heapSnapshotLocked(opts));
	}

	async _heapSnapshotLocked(opts) {
		if (this._profiling) {
			throw new Error(
				'a CPU recording is in progress — a heap snapshot forces a full GC and a long V8 pause ' +
				'that would poison it; stop the CPU profile first (tv_profile action:stop)'
			);
		}
		const cdp = await this._cdp();
		const timeoutMs = Math.min(600000, Math.max(5000, Math.floor(opts.timeoutMs || HEAP_SNAPSHOT_TIMEOUT_MS)));
		const outPath = opts.path
			? resolve(opts.path)
			: resolve(process.env.TMPDIR || '/tmp', `tv-heap-${this.cfg.id}-${Date.now()}.heapsnapshot`);
		const startedAt = Date.now();
		const warnings = [];

		try {
			await cdp.call('HeapProfiler.enable');
		} catch (e) {
			throw this._heapUnsupported(e, 'HeapProfiler.enable');
		}

		const stream = createWriteStream(outPath);
		/** @type {?Error} */
		let writeError = null;
		let bytes = 0;
		let chunks = 0;
		let lastPercent = -1;
		stream.on('error', (e) => {
			writeError = e;
		});

		const offChunk = cdp.onEvent('HeapProfiler.addHeapSnapshotChunk', (p) => {
			if (typeof p.chunk !== 'string' || writeError) {
				return;
			}
			bytes += Buffer.byteLength(p.chunk);
			chunks++;
			stream.write(p.chunk);
		});
		const offProgress = cdp.onEvent('HeapProfiler.reportHeapSnapshotProgress', (p) => {
			if (!p.total) {
				return;
			}
			// Progress goes to stderr, not into the answer: it is for a human watching a
			// snapshot that takes a minute, and it would be noise in the tool response.
			// Deliberately not paired with the bytes written: engines report the walk as done
			// long before the last chunk is on the wire (webOS 3 reaches 100% with the file
			// still empty), so the two numbers together would read as a stall.
			const percent = Math.floor((p.done / p.total) * 100);
			if (percent >= lastPercent + 25) {
				lastPercent = percent;
				this._log(`heap snapshot: serialising ${percent}%`);
			}
		});

		const abort = async (message) => {
			offChunk();
			offProgress();
			await closeStream(stream).catch(() => {});
			let removed = false;
			try {
				unlinkSync(outPath);
				removed = true;
			} catch {
				// never written, or already gone
			}
			await cdp.call('HeapProfiler.disable').catch(() => {});
			// Half a snapshot is unusable JSON that DevTools cannot open and this parser would
			// reject — say it is gone rather than leaving 100MB of garbage behind.
			throw new Error(`${message}${removed ? ` — the partial file ${outPath} was removed` : ''}`);
		};

		try {
			await cdp.call('HeapProfiler.takeHeapSnapshot', {reportProgress: true}, timeoutMs);
		} catch (e) {
			if (isUnsupportedMethod(e)) {
				await abort(this._heapUnsupported(e, 'HeapProfiler.takeHeapSnapshot').message);
			}
			await abort(`heap snapshot failed after ${Date.now() - startedAt}ms: ${e.message}`);
		}

		// Some engines answer the call before the last chunks are on the wire. Wait for the
		// stream to go quiet instead of trusting the reply, bounded so a chatty engine cannot
		// hold the tool call forever.
		const drainDeadline = Date.now() + HEAP_DRAIN_MAX_MS;
		let seen = -1;
		while (bytes !== seen && Date.now() < drainDeadline) {
			seen = bytes;
			await sleep(HEAP_DRAIN_QUIET_MS);
		}
		if (bytes !== seen) {
			warnings.push(`chunks were still arriving after ${HEAP_DRAIN_MAX_MS}ms — the file may be truncated`);
		}

		offChunk();
		offProgress();
		await closeStream(stream).catch((e) => {
			writeError = writeError || e;
		});
		await cdp.call('HeapProfiler.disable').catch(() => {});

		if (writeError) {
			try {
				unlinkSync(outPath);
			} catch {
				// ignore
			}
			throw new Error(`could not write the snapshot to ${outPath}: ${writeError.message} — the partial file was removed`);
		}
		if (!bytes) {
			try {
				unlinkSync(outPath);
			} catch {
				// ignore
			}
			throw new Error(
				`the engine (${this.cfg.engine || this.cfg.platform}) accepted HeapProfiler.takeHeapSnapshot but streamed no data — ` +
				'no snapshot was written'
			);
		}

		const durationMs = Date.now() - startedAt;
		this._log(`heap snapshot written: ${Math.round(bytes / (1024 * 1024))}MB in ${chunks} chunks, ${durationMs}ms -> ${outPath}`);
		let summary = null;
		try {
			summary = summarizeHeapSnapshot(outPath, {topN: opts.topN});
			if (summary.ok === false && summary.warning) {
				warnings.push(summary.warning);
			}
		} catch (e) {
			// The file is the deliverable; a parser that cannot read it must not throw the
			// snapshot away with it.
			warnings.push(`summary unavailable: ${e.message}`);
		}
		return {
			ok: true,
			path: outPath,
			bytes,
			chunks,
			durationMs,
			summary,
			...(warnings.length ? {warning: warnings.join('; ')} : {})
		};
	}

	/**
	 * @param {Error} e
	 * @param {string} method
	 * @return {Error}
	 */
	_heapUnsupported(e, method) {
		if (isUnsupportedMethod(e)) {
			return new Error(
				`heap snapshots not supported on this engine (${this.cfg.engine || this.cfg.platform}): ${method} — ` +
				`${e.message}. tv_profile action:"metrics" still reports JSHeapUsedSize on Chromium 60+.`
			);
		}
		return e;
	}

	/**
	 * Wait until a condition holds. See wait.js for the condition shapes.
	 * @param {object} condition
	 * @param {{timeoutMs?: number, intervalMs?: number, stableMs?: number}} [opts]
	 */
	async waitFor(condition, opts = {}) {
		const io = {
			evaluate: (js) => this.evaluate(js, true),
			videoState: (gap) => this.videoState(gap)
		};
		const res = await pollUntil(io, this.profile, condition, opts);
		return {...res, state: await this.state().catch(() => null)};
	}

	/**
	 * Press a direction until the FOCUSED element matches the target.
	 *
	 * Bounded three ways, because an unbounded "press until it looks right" loop on a TV is
	 * how you burn ten minutes: `maxSteps`, a wall-clock `deadlineMs`, and two structural
	 * stops — focus that stopped moving (edge of a list) and focus that returned to a
	 * position we already visited (a carousel that wraps).
	 * @param {{direction: string, text?: string, selector?: string, testid?: string,
	 *          maxSteps?: number, deadlineMs?: number}} opts
	 */
	async goto(opts) {
		const direction = String(opts.direction || '').toUpperCase();
		if (!direction) {
			throw new Error('tv_goto needs a direction (UP / DOWN / LEFT / RIGHT)');
		}
		const target = {text: opts.text, selector: opts.selector, testid: opts.testid};
		if (target.text == null && target.selector == null && target.testid == null) {
			throw new Error('tv_goto needs a target: text, selector or testid');
		}
		const maxSteps = Math.min(200, Math.max(1, Math.floor(opts.maxSteps || 30)));
		const deadline = Date.now() + (opts.deadlineMs || 45000);
		const matchJs = focusMatchesJs(this.profile, target);
		const steps = [];
		const seen = new Set();

		let match = await this.evaluate(matchJs, true);
		if (match.ok) {
			return {ok: true, presses: 0, reason: 'already on target', focus: match.detail, steps};
		}
		let sig = await this.focusSignature();
		seen.add(sig);

		for (let i = 0; i < maxSteps; i++) {
			if (Date.now() > deadline) {
				return {ok: false, reason: 'deadline reached', presses: i, steps, focus: match.detail};
			}
			await this.press(direction);
			const nextSig = await this.focusSignature();
			match = await this.evaluate(matchJs, true);
			steps.push({press: direction, focus: match.detail ? match.detail.text : null, matched: !!match.ok});

			if (match.ok) {
				return {ok: true, presses: i + 1, steps, focus: match.detail};
			}
			if (nextSig === sig) {
				return {ok: false, reason: `focus stopped moving on ${direction} (edge of the list?)`, presses: i + 1, steps, focus: match.detail};
			}
			if (seen.has(nextSig)) {
				return {ok: false, reason: 'focus returned to a position already visited (wrapped around)', presses: i + 1, steps, focus: match.detail};
			}
			seen.add(nextSig);
			sig = nextSig;
		}
		return {ok: false, reason: `target not reached in ${maxSteps} presses`, presses: maxSteps, steps, focus: match.detail};
	}

	/**
	 * Move focus into the app's menu and pick a section by name. Needs a `menu` block in the
	 * app profile — that is the app-specific knowledge the MCP itself must not hard-code.
	 * @param {?string} name section title (omit to just open the menu and list the items)
	 * @param {{select?: boolean, maxOpenPresses?: number, deadlineMs?: number}} [opts]
	 */
	async menu(name, opts = {}) {
		const menu = requireMenu(this.profile);
		// Reaching the sidebar takes one press per column you are away from it, so a fixed
		// small count fails as soon as the case has navigated a few tiles right. Press until
		// focus is inside the menu, bounded the same way tv_goto is.
		const maxOpen = Math.min(50, Math.max(1, Math.floor(opts.maxOpenPresses || 20)));
		const openPresses = [];
		let st = await this.state();
		let sig = await this.focusSignature();
		let seen = new Set([sig]);
		// Some screens don't let the open key cross back to the sidebar at all — inside a
		// settings-style section LEFT can do nothing and you have to leave with BACK first.
		// One such escape press, then carry on; without it tv_menu is only usable from the
		// catalog.
		let escapesLeft = menu.exitKey ? 1 : 0;

		for (let i = 0; i < maxOpen && !st.focusInMenu; i++) {
			await this.press(menu.openKey);
			const nextSig = await this.focusSignature();
			st = await this.state();
			openPresses.push({press: menu.openKey, focus: st.focus ? st.focus.text : null, focusInMenu: !!st.focusInMenu});
			if (st.focusInMenu) {
				break;
			}
			if (nextSig === sig || seen.has(nextSig)) {
				if (escapesLeft > 0) {
					escapesLeft--;
					await this.press(menu.exitKey);
					st = await this.state();
					sig = await this.focusSignature();
					seen = new Set([sig]);
					openPresses.push({press: menu.exitKey, focus: st.focus ? st.focus.text : null, focusInMenu: !!st.focusInMenu, note: 'escape from the section'});
					continue;
				}
				return {
					ok: false,
					reason: `focus stopped moving on ${menu.openKey} before reaching the menu`,
					openPresses,
					state: st
				};
			}
			seen.add(nextSig);
			sig = nextSig;
		}
		if (!st.focusInMenu) {
			return {
				ok: false,
				reason: `focus did not reach the menu within ${maxOpen}x ${menu.openKey}`,
				openPresses,
				state: st
			};
		}
		const items = await this.evaluate(menuItemsJs(this.profile), true).catch(() => []);
		if (!name) {
			return {ok: true, opened: true, items, state: st};
		}

		// Match on the text AND on "this is a menu item". Text alone is not enough: a Settings
		// screen contains rows whose text also says "Main", and selecting one of those looks
		// like success while the app never leaves the section.
		const steps = Math.max(items.length + 2, 12);
		const target = {text: name, selector: menu.item};
		let res = await this.goto({direction: 'DOWN', ...target, maxSteps: steps, deadlineMs: opts.deadlineMs});
		if (!res.ok) {
			res = await this.goto({direction: 'UP', ...target, maxSteps: steps, deadlineMs: opts.deadlineMs});
		}
		if (!res.ok) {
			return {ok: false, reason: `menu item "${name}" not found`, items, goto: res, state: await this.state()};
		}
		const select = opts.select !== false;
		if (select) {
			await this.press('ENTER');
		}
		return {ok: true, chosen: name, items, selected: select, presses: res.presses, state: await this.state()};
	}

	/**
	 * Run a whole case body in one call, under the operation lock, with a verdict per step.
	 * @param {Array<object>} steps
	 * @param {{stopOnFail?: boolean}} [opts]
	 */
	async sequence(steps, opts = {}) {
		if (!Array.isArray(steps) || !steps.length) {
			throw new Error('tv_sequence needs a non-empty steps array');
		}
		return this.withOperationLock(async () => {
			const stopOnFail = opts.stopOnFail !== false;
			const out = [];
			let failedAt = null;

			for (let i = 0; i < steps.length; i++) {
				const step = steps[i];
				const t0 = Date.now();
				let ok = true;
				let result;
				try {
					result = await this._runStep(step);
					if (result && result.ok === false) {
						ok = false;
					}
				} catch (e) {
					ok = false;
					result = {error: e.message};
				}
				out.push({index: i, step: stepLabel(step), ok, elapsedMs: Date.now() - t0, result});
				if (!ok) {
					failedAt = i;
					if (stopOnFail) {
						break;
					}
				}
			}
			return {
				ok: failedAt === null,
				failedAt,
				ran: out.length,
				of: steps.length,
				steps: out,
				finalState: await this.state().catch(() => null)
			};
		});
	}

	/** @param {object} step */
	async _runStep(step) {
		if (step.launch) {
			// A case that assumes "we are on the catalog" fails the moment the previous run
			// left the app in the player. Letting a sequence establish its own precondition is
			// what makes it re-runnable.
			const opts = step.launch === true ? {relaunch: true} : step.launch;
			const page = await this.ensureConnected(opts);
			return {ok: true, attached: page};
		}
		if (step.press != null) {
			return this.press(step.press, {repeat: step.repeat, intervalMs: step.intervalMs, durationMs: step.durationMs});
		}
		if (step.longpress != null) {
			return this.press(step.longpress, {durationMs: step.durationMs || 1500});
		}
		if (step.goto) {
			return this.goto(step.goto);
		}
		if (step.menu !== undefined) {
			return this.menu(step.menu, step.options || {});
		}
		if (step.wait) {
			return this.waitFor(step.wait, {timeoutMs: step.timeoutMs, stableMs: step.stableMs, intervalMs: step.intervalMs});
		}
		if (step.expect) {
			return this.waitFor(step.expect, {timeoutMs: step.timeoutMs != null ? step.timeoutMs : 5000, stableMs: step.stableMs});
		}
		if (step.eval != null) {
			return {ok: true, value: await this.evaluate(step.eval, true)};
		}
		if (step.sleep != null) {
			await sleep(Math.min(60000, Math.max(0, Math.floor(step.sleep))));
			return {ok: true, slept: step.sleep};
		}
		if (step.videoState) {
			const v = await this.videoState(step.sampleGapMs);
			const wantAdvancing = step.expectAdvancing !== false;
			return {...v, ok: wantAdvancing ? !!v.advancing : true};
		}
		if (step.state) {
			return {ok: true, state: await this.state()};
		}
		// Profiling has to be expressible as steps: tv_sequence holds the operation lock, so a
		// separate tv_profile call cannot slip in between two steps of the scenario it measures.
		if (step.profileStart !== undefined) {
			return this.profileStart(step.profileStart === true ? {} : step.profileStart);
		}
		if (step.profileStop !== undefined) {
			return this.profileStopAndSave(step.profileStop === true ? {} : step.profileStop);
		}
		if (step.metrics !== undefined) {
			// A bare snapshot step, so a scenario can bracket ANY part of itself — not just the
			// part a CPU recording covers. Diffing two of them is the caller's job.
			const o = step.metrics && typeof step.metrics === 'object' ? step.metrics : {};
			return {ok: true, ...(await this.metricsSnapshot(o))};
		}
		throw new Error(
			`unknown step ${JSON.stringify(step).slice(0, 120)} — expected one of: ` +
			'launch, press, longpress, goto, menu, wait, expect, eval, sleep, videoState, state, ' +
			'profileStart, profileStop, metrics'
		);
	}

	/**
	 * @param {number} [timeoutMs]
	 * @return {Promise<{ok: boolean, buffer?: Buffer, reason?: string}>}
	 */
	async screenshot(timeoutMs = 6000) {
		const cdp = await this._cdp();
		try {
			const buffer = await cdp.screenshot(timeoutMs);
			return {ok: true, buffer};
		} catch (e) {
			return {ok: false, reason: e.message};
		}
	}

	/**
	 * @param {{filter?: string, levels?: Array<string>, limit?: number}} [opts]
	 */
	consoleReport({filter, levels, limit = 60} = {}) {
		if (!this.cdp) {
			throw new Error(`device "${this.cfg.id}" is not launched — call tv_launch first`);
		}
		const cdp = this.cdp;
		const take = Math.max(1, Math.floor(limit) || 60); // slice(-0) would return everything
		const needle = filter ? String(filter).toLowerCase() : null;
		const matchText = (s) => !needle || String(s || '').toLowerCase().includes(needle);
		const wantLevel = (m) => !levels || !levels.length || levels.includes(m.level);

		return {
			errors: cdp.exceptions.filter((m) => matchText(m.text)).slice(-take),
			console: cdp.console.filter((m) => wantLevel(m) && matchText(m.text)).slice(-take),
			networkFailures: cdp.networkFailures
				.filter((n) => matchText(n.url) || matchText(n.errorText))
				.slice(-take),
			totals: {
				console: cdp.console.length,
				exceptions: cdp.exceptions.length,
				networkFailures: cdp.networkFailures.length
			},
			droppedFromBuffer: cdp.dropped
		};
	}

	async dispose() {
		// Leaving V8 sampling on in an app that keeps running after we detach is a real cost on
		// a TV — stop it while the socket is still alive.
		if (this._profiling && this.cdp && this.cdp.isOpen) {
			await this.cdp.call('Profiler.stop', {}, 5000).catch(() => {});
			await this.cdp.call('Profiler.disable', {}, 5000).catch(() => {});
		}
		// Same reasoning for the Performance domain: it keeps instrumenting an app that outlives
		// this process.
		if (this._metricsEnabledFor && this.cdp && this.cdp.isOpen) {
			await this.cdp.call('Performance.disable', {}, 5000).catch(() => {});
		}
		this._metricsEnabledFor = null;
		this._profiling = null;
		if (this.cdp) {
			this.cdp.close();
			this.cdp = null;
		}
		// The sdb forward rule is deliberately LEFT in place: it is the only record of the
		// device-side inspector port, so it is what lets a later `tv_launch {attach:true}`
		// reattach to a still-running app after this process is gone. `forward()` clears
		// stale rules for the device before adding a new one, so they don't accumulate.
		if (this.adapter.dispose) {
			await this.adapter.dispose().catch(() => {});
		}
	}
}
