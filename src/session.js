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

import {createWriteStream, unlinkSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {TizenAdapter} from './adapters/tizen.js';
import {WebosAdapter} from './adapters/webos.js';
import {VidaaAdapter} from './adapters/vidaa.js';
import {PcAdapter} from './adapters/pc.js';
import {SyntheticInput} from './input/synthetic.js';
import {TrustedInput} from './input/trusted.js';
import {CdpSession, resolvePageWs, sleep, isUnsupportedMethod, MAX_POSTDATA_BYTES} from './cdp.js';
import {resolveKey} from './keymaps.js';
import {pressJs, videoStateJs, videoSampleStartJs, videoSampleFinishJs, PAGE_SLOT_TTL_MS} from './inject.js';
import {snapshotJs, focusIsRefBody, snapshotReleaseJs} from './snapshot.js';
import {recorderInstallJs, recorderDrainJs, recorderStopJs, recorderStatusJs} from './record-inject.js';
import {Timeline, compileCase, renderCase, slugify} from './recorder.js';
import {freePort} from './ports.js';
import {loadAppProfile, requireMenu, resolveTarget, resolveCondition} from './appprofile.js';
import {stateJs, focusSignatureJs, focusMatchesBody, focusInMenuBody, sigAndMatchJs, menuItemsJs, helpersInstallJs} from './state.js';
import {pollUntil, pollRequests, describeCondition} from './wait.js';
import {selectRequests, toListEntry, buildCurl, buildHar, capBody, HAR_BODY_TOTAL_LIMIT} from './network.js';
import {summarizeProfile, applySourceMap, saveProfile} from './profile.js';
import {summarizeHeapSnapshot} from './heap.js';
import {metricsToMap, metricsDiff, windowSecondsOf} from './metrics.js';
import {capEvalValue} from './render.js';
import {PKG_VERSION} from './version.js';

/** A big profile off a slow TV takes far longer to serialise than a normal CDP round-trip. */
const PROFILE_STOP_TIMEOUT_MS = 60000;
/** How often the host empties the page-side recorder buffer. */
const RECORD_DRAIN_MS = 300;
/** Page-side ring buffer size. Overflow is counted and reported, never hidden. */
const RECORD_BUFFER_CAP = 400;
/** Where recorded cases land unless told otherwise — gitignored, see .gitignore. */
const RECORDED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'cases', 'recorded');
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
 * Press settle defaults per platform: how long the focus has to stay put before a press is
 * "done", and how long to wait for it to move at all. The app profile's `settle` block wins.
 * A local Chrome renders the next frame in 16ms; a TV framework animates the move.
 */
const SETTLE_DEFAULTS = {
	pc: {quietMs: 80, changeTimeoutMs: 800},
	vidaa: {quietMs: 120, changeTimeoutMs: 1000},
	default: {quietMs: 150, changeTimeoutMs: 1200}
};
/**
 * Sequence steps whose RESULT is the point (a reading, a file, a measured request): they keep
 * it in the compact report. Everything else is navigation and is reported as one line.
 */
const READ_STEPS = ['eval', 'videoState', 'state', 'snapshot', 'profileStart', 'profileStop', 'metrics', 'expectRequest'];

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

/**
 * One line about a green navigation step, for the compact sequence report.
 * @param {object} step
 * @param {*} result
 * @return {?string}
 */
function stepBrief(step, result) {
	if (!result || typeof result !== 'object') {
		return null;
	}
	const cut = (v, n = 120) => {
		const t = typeof v === 'string' ? v : JSON.stringify(v);
		return t && t.length > n ? t.slice(0, n) + '…' : t;
	};
	if (step.launch) {
		const a = result.attached || {};
		const boot = a.bootReady ? ` bootReady ${a.bootReady.ok ? 'ok' : 'FAILED'} ${a.bootReady.elapsedMs}ms` : '';
		return `${a.href || ''}${boot}${a.warning ? ' warning: ' + a.warning : ''}`;
	}
	if (step.press != null || step.longpress != null) {
		return `${result.focus || ''}${result.changed === false ? ' (focus did not change)' : ''}`;
	}
	if (step.goto) {
		const f = result.focus && result.focus.text != null ? ` -> ${cut(result.focus.text, 60)}` : '';
		return `${result.trail || result.reason || ''}${f}`;
	}
	if (step.menu !== undefined) {
		const f = result.state && result.state.focus ? ` focus ${cut(result.state.focus.text, 60)}` : '';
		return `${result.chosen ? 'chose ' + result.chosen : 'opened'} (${(result.items || []).length} items)${f}`;
	}
	if (step.wait || step.expect) {
		return `${result.condition || ''} ${cut(result.detail, 80)} ${result.elapsedMs}ms`;
	}
	if (step.networkMark !== undefined) {
		return 'marked';
	}
	if (step.sleep != null) {
		return `slept ${result.slept}ms`;
	}
	return cut(result, 160);
}

function makeAdapter(cfg, log) {
	if (cfg.platform === 'tizen') {
		return new TizenAdapter({host: cfg.host, sdbPort: cfg.sdbPort, cliTarget: cfg.cliTarget, log});
	}
	if (cfg.platform === 'webos') {
		return new WebosAdapter({device: cfg.device, log});
	}
	if (cfg.platform === 'vidaa') {
		return new VidaaAdapter({host: cfg.host, port: cfg.port, log});
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
		/**
		 * The CdpSession found to have no `Performance` domain, i.e. the one reading metrics off
		 * `Memory.getDOMCounters` instead. Same instance-comparison trick as above: a reattach
		 * re-probes the engine rather than inheriting a verdict about a connection that is gone.
		 * @type {?CdpSession}
		 */
		this._metricsFallbackFor = null;
		/**
		 * Start of the network assertion window, set by a `networkMark` step / `action:"mark"`.
		 * Null means "each expectRequest looks at its own step only".
		 * @type {?number}
		 */
		this._networkMarkAt = null;
		/**
		 * Live remote recording, if any. Like `_profiling`, it remembers the CdpSession it was
		 * installed on rather than a boolean: a silent reattach gives a NEW V8 where the
		 * page-side recorder does not exist, and comparing instances is how that is noticed.
		 * @type {?{cdp: CdpSession, timeline: Timeline, startedAt: number, opts: object,
		 *          timer: ?ReturnType<typeof setInterval>, trusted: ?number, keysSeen: number}}
		 */
		this._recorder = null;
		/** The compiled-but-unwritten case held between `stop` and an explicit `write`. */
		this._pendingCase = null;
		this._lifecycleLock = Promise.resolve();
		this._opLock = Promise.resolve();
		/** Separates concurrent two-call video samples on the legacy eval dialect. */
		this._videoSampleSeq = 0;
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
	 * @param {{reload?: boolean, relaunch?: boolean, attach?: boolean, waitBoot?: boolean}} [opts]
	 */
	ensureConnected(opts = {}) {
		return this._locked('_lifecycleLock', () => this._ensureConnectedLocked(opts))
			// OUTSIDE the lock, and it has to stay outside: the boot wait evaluates page JS,
			// and `_cdp()` on a dropped socket reaches for `_lifecycleLock` itself. Anything
			// touching the page from inside `_ensureConnectedLocked` deadlocks the session.
			.then((page) => this._waitBootReady(page, opts));
	}

	/**
	 * Wait for the app profile's `bootReady` condition after attaching, so the answer to
	 * tv_launch finally says whether the app actually came up — and every case stops opening
	 * with a hand-written `{wait: …}` step that repeats the profile.
	 *
	 * Never throws. The attach itself succeeded; an app that did not boot is a FINDING, and
	 * throwing here would take away tv_console / tv_network at the exact moment they matter.
	 * @param {?object} page
	 * @param {{reload?: boolean, relaunch?: boolean, waitBoot?: boolean}} opts
	 * @return {Promise<?object>}
	 */
	async _waitBootReady(page, opts) {
		const boot = this.profile.bootReady;
		if (!page || !boot || opts.waitBoot === false) {
			return page;
		}
		// Attaching to a running app must not wait for the catalog: it may legitimately be
		// deep in the player, where the boot selector never appears again.
		if (!page.freshLaunch && !opts.reload) {
			return page;
		}
		// Already answered for this page object; a plain re-attach must not pay for it twice.
		if (page.bootReady && !opts.relaunch && !opts.reload) {
			return page;
		}
		const timeoutMs = boot.timeoutMs || 30000;
		let cond = null;
		if (boot.selector != null) {
			cond = {selector: boot.selector};
		} else if (boot.scene != null) {
			cond = {scene: boot.scene};
		}
		if (!cond) {
			page.bootReady = {ok: false, reason: 'bootReady block has neither "selector" nor "scene"'};
			page.warning = `app profile "${this.profile.id}" has a bootReady block with nothing to wait for`;
			return page;
		}
		const started = Date.now();
		let res;
		try {
			// stableMs, because cases/README.md already records the trap: the selector exists
			// before the tile has any content in it.
			res = await this.waitFor(cond, {timeoutMs, stableMs: 300});
		} catch (e) {
			page.bootReady = {ok: false, elapsedMs: Date.now() - started, condition: describeCondition(cond), reason: e.message};
			page.warning = `boot readiness could not be checked: ${e.message}`;
			return page;
		}
		page.bootReady = {
			ok: !!res.ok,
			elapsedMs: res.elapsedMs != null ? res.elapsedMs : Date.now() - started,
			condition: res.condition || describeCondition(cond)
		};
		if (!res.ok) {
			page.warning =
				`app did not reach bootReady (${page.bootReady.condition}) within ${timeoutMs}ms — ` +
				'attached anyway, so tv_console / tv_network can say why';
		}
		return page;
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
	 * Evaluate a snippet built on the shared page-side helpers (state.js withHelpersJs).
	 * The helpers are installed on first use and after anything that blew the page away — a
	 * navigation, a reload, a reattach to a new V8 — which the snippet reports itself.
	 * @param {string} js
	 * @param {{awaitPromise?: boolean, timeoutMs?: number}} [opts]
	 * @return {Promise<*>}
	 */
	async _pageCall(js, opts = {}) {
		const cdp = await this._cdp();
		let res = await cdp.evaluate(js, opts);
		if (res && res.__tvdbgMissing) {
			await cdp.evaluate(helpersInstallJs(this.profile), {awaitPromise: false});
			res = await cdp.evaluate(js, opts);
			if (res && res.__tvdbgMissing) {
				throw new Error('the page-side helpers could not be installed (is the page still loading?)');
			}
		}
		return res;
	}

	/** Start of a cost window: {t0, calls} — see `_cost`. */
	_tick() {
		return {t0: Date.now(), calls: this.cdp ? this.cdp.calls : 0};
	}

	/**
	 * What an operation cost: wall time and CDP calls since `_tick`. Reported as `ms` / `evals`
	 * so a slow step can be told from a slow TV.
	 * @param {{t0: number, calls: number}} tick
	 * @return {{ms: number, evals: number}}
	 */
	_cost(tick) {
		return {ms: Date.now() - tick.t0, evals: this.cdp ? this.cdp.calls - tick.calls : 0};
	}

	/**
	 * Settle thresholds for this device: profile `settle` block over platform defaults.
	 * @return {{quietMs: number, changeTimeoutMs: number}}
	 */
	_settleOpts() {
		const base = SETTLE_DEFAULTS[this.platform] || SETTLE_DEFAULTS.default;
		const prof = this.profile.settle || {};
		return {
			quietMs: prof.quietMs != null ? prof.quietMs : base.quietMs,
			changeTimeoutMs: prof.changeTimeoutMs != null ? prof.changeTimeoutMs : base.changeTimeoutMs
		};
	}

	/**
	 * Dispatch a key and wait for the focus to settle — ONE page-side call on a synthetic-input
	 * device (see inject.js pressJs). For a long-press, hold = keydown, wait durationMs, keyup.
	 * `repeat` fires the whole press N times with `intervalMs` between, and only the last one
	 * settles. `before` and `matchBody` let tv_goto / tv_menu fold their own reads into the
	 * same call.
	 *
	 * Trusted input (a local Chrome by default) is the one exception: its keys go through the
	 * CDP Input domain, so that path is keyDown/keyUp calls plus the same page-side settle.
	 * @param {string|number} keyName
	 * @param {{durationMs?: number, repeat?: number, intervalMs?: number, settle?: boolean,
	 *          before?: ?string, matchBody?: ?string}} [opts]
	 * @return {Promise<{before: ?string, after: ?string, changed: ?boolean, focus: ?object,
	 *                   match: *, presses: number, ms: number, evals: number}>}
	 */
	async _press(keyName, opts = {}) {
		const cdp = await this._cdp();
		const tick = this._tick();
		const spec = resolveKey(this.platform, keyName);
		const repeat = Math.max(1, Math.floor(opts.repeat || 1));
		const interval = opts.intervalMs != null ? Math.max(0, Math.floor(opts.intervalMs)) : 250;
		const hold = Math.max(0, Math.floor(opts.durationMs || 0));
		const settle = opts.settle !== false;
		const thresholds = this._settleOpts();
		const pageSide = this.input.mode === 'synthetic';
		let before = opts.before != null ? String(opts.before) : null;

		if (!pageSide) {
			if (settle && before === null) {
				before = await this._pageCall(focusSignatureJs(this.profile)).catch(() => null);
			}
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
			if (!settle) {
				return {before, after: null, changed: null, focus: null, match: null, presses: repeat, ...this._cost(tick)};
			}
		}
		// The call must outlive the burst it fires plus the settle it waits for.
		const budget = (pageSide ? repeat * (hold + interval) : 0) +
			(settle ? thresholds.changeTimeoutMs + 2000 : 0) + 4000;
		const r = await this._pageCall(pressJs(this.profile, spec, {
			dispatch: pageSide, repeat, intervalMs: interval, holdMs: hold, settle, before,
			quietMs: thresholds.quietMs, changeTimeoutMs: thresholds.changeTimeoutMs, matchBody: opts.matchBody
		}), {awaitPromise: true, timeoutMs: budget});
		if (!r || typeof r !== 'object') {
			throw new Error('the press did not report back (page navigated during the settle?)');
		}
		// Trusted keys were fired above, not by the page — the page-side count is 0 there.
		return {...r, presses: pageSide ? r.presses : repeat, ...this._cost(tick)};
	}

	/**
	 * tv_press: the compact answer. Focus after the press and whether it moved; the focus
	 * before only when it did not (that is when the caller needs it); repeat/holdMs only when
	 * they were not the defaults. inputMode/keyCode are in the tv_launch answer, once.
	 * @param {string|number} keyName
	 * @param {{durationMs?: number, repeat?: number, intervalMs?: number, settle?: boolean}} [opts]
	 */
	async press(keyName, opts = {}) {
		const r = await this._press(keyName, opts);
		const out = {key: String(keyName)};
		if (opts.settle === false) {
			out.settled = false;
		} else {
			out.focus = r.after;
			out.changed = r.changed;
			if (!r.changed) {
				out.before = r.before;
			}
		}
		if (r.presses > 1) {
			out.repeat = r.presses;
		}
		if (opts.durationMs) {
			out.holdMs = Math.floor(opts.durationMs);
		}
		out.ms = r.ms;
		out.evals = r.evals;
		return out;
	}

	/** Structured snapshot: url, title, visible scenes, focused element, popups, counts. */
	async state(opts = {}) {
		return this._pageCall(stateJs(this.profile, opts));
	}

	/**
	 * A structural read of the screen around the focus: the rows, their items, and where the
	 * focus sits among them. One call instead of press-look-press-look.
	 * @param {{detail?: 'focus'|'rows'|'full', maxRows?: number, maxItemsPerRow?: number,
	 *          release?: boolean}} [opts]
	 */
	async snapshot(opts = {}) {
		if (opts.release) {
			const res = await this.evaluate(snapshotReleaseJs(), true).catch((e) => ({released: false, reason: e.message}));
			return {ok: true, ...res};
		}
		const out = await this.evaluate(snapshotJs(this.profile, {...opts, ttlMs: PAGE_SLOT_TTL_MS}), true);
		if (!out || typeof out !== 'object') {
			return {ok: false, reason: 'the page returned no snapshot', raw: out};
		}
		out.ok = true;
		if (!out.rows || !out.rows.length) {
			// Never invent structure: an agent WILL navigate by a made-up row.
			out.warning =
				'no rows could be derived — add a "snapshot" block (row/item selectors) or a "tile" ' +
				`selector to apps/${this.profile.id}.json, or use detail:"focus"`;
		} else {
			// "The selector is visible" is not "the content is rendered" — cases/README.md records
			// that trap, and a snapshot taken inside that window returns a grid of empty strings.
			// The layout is real, the labels are not there YET, and an agent planning by them is
			// planning by nothing. Say so instead of returning a silently useless answer.
			let items = 0;
			let labelled = 0;
			for (const row of out.rows) {
				for (const it of row.items || []) {
					items++;
					if (it.t) {
						labelled++;
					}
				}
			}
			if (items > 0 && labelled === 0) {
				out.warning =
					'the layout is there but not one item has text yet — the app is probably still ' +
					'rendering. Take another snapshot, or wait on the text you need (tv_wait_for).';
			}
		}
		// The size of this very answer, so the agent can see what the call costs it and drop to
		// detail:"focus" when the rows are not what the next move needs.
		let bytes = JSON.stringify(out).length;
		for (let i = 0; i < 3; i++) {
			const next = JSON.stringify({...out, bytes}).length;
			if (next === bytes) {
				break;
			}
			bytes = next;
		}
		out.bytes = bytes;
		return out;
	}

	// ---------------------------------------------------------------------------------------
	// tv_record — the person drives with the physical remote, the MCP writes the case.
	//
	// The drain takes NO lock, deliberately. `_opLock` would block tv_sequence for the whole
	// recording, and `_cdp()` (which reaches for `_lifecycleLock` on a dead socket) would fight
	// a user's own `tv_launch relaunch:true`. Draining is a read of a page-side array; a tick
	// with no live socket is simply skipped, and the gap is reported rather than smoothed over.
	// ---------------------------------------------------------------------------------------

	/**
	 * @param {{assert?: string, longPressMs?: number, collapse?: boolean, heartbeatMs?: number,
	 *          overlay?: boolean, relaunch?: boolean}} [opts]
	 */
	async recordStart(opts = {}) {
		if (this._recorder) {
			throw new Error(
				`a recording is already running on "${this.cfg.id}" (started ${Math.round((Date.now() - this._recorder.startedAt) / 1000)}s ago) — ` +
				'stop it first with tv_record action:"stop"'
			);
		}
		// Relaunch first, by default. Every compiled case opens with {launch:{relaunch:true}} —
		// so a recording that began wherever the app happened to be produces a case whose first
		// step contradicts all the others: the replay starts on the catalog, the recording started
		// three screens in, and the case goes red for a reason that has nothing to do with the app.
		// Recording from a fresh launch makes the two starting states the same one.
		const warnings = [];
		const relaunch = opts.relaunch !== false;
		let bootReady = null;
		if (relaunch) {
			const page = await this.ensureConnected({relaunch: true});
			bootReady = (page && page.bootReady) || null;
			if (bootReady && bootReady.ok === false) {
				// Not a throw: an app that did not reach bootReady is a finding, and the person
				// may well be about to record exactly that. Say it and keep going.
				warnings.push(
					`the app did not reach bootReady in ${bootReady.elapsedMs}ms (${JSON.stringify(bootReady.condition)}) — ` +
					'recording anyway, but the first steps may have been pressed into a screen that was still loading'
				);
			}
		} else {
			// The escape hatch, and the case has to carry its cost: this warning is copied into
			// the compiled case at stop, because it is a property of the case, not of the session.
			warnings.push(
				'recorded with relaunch:false, so the recording did not start from a fresh launch — the compiled case ' +
				'still opens with {launch:{relaunch:true}} and will replay from wherever THAT lands. Check the first steps by hand.'
			);
		}
		const cdp = await this._cdp();
		const installed = await this._installRecorder(cdp, opts);
		this._recorder = {
			cdp, timeline: new Timeline(), startedAt: Date.now(), opts,
			timer: null, trusted: installed.trusted, keysSeen: 0,
			// Carried into the compiled case: whoever reads the case later never sees this answer.
			caseWarnings: relaunch ? [] : warnings.slice()
		};
		this._recorder.timeline.setClock(installed.t0, Date.now());
		this._recorder.timer = setInterval(() => {
			this._recorderTick().catch(() => {});
		}, RECORD_DRAIN_MS);
		// Never hold the process open for a recording nobody stopped.
		if (this._recorder.timer.unref) {
			this._recorder.timer.unref();
		}

		if (!installed.trusted) {
			warnings.push(
				'this engine does not report Event.isTrusted (below Chrome 46), so synthetic presses ' +
				'from other tools will be recorded as if they came from the remote'
			);
		}
		return {
			ok: true, recording: true, device: this.cfg.id, target: installed.target,
			overlay: opts.overlay !== false,
			relaunched: relaunch,
			...(bootReady ? {bootReady} : {}),
			note: 'нажимайте пультом; на экране горит «● REC». Закончив — tv_record action:"stop"',
			...(warnings.length ? {warnings} : {})
		};
	}

	/**
	 * @param {CdpSession} cdp
	 * @param {object} opts
	 */
	async _installRecorder(cdp, opts) {
		const js = recorderInstallJs(this.profile, {
			cap: RECORD_BUFFER_CAP,
			heartbeatMs: opts.heartbeatMs,
			overlay: opts.overlay !== false
		});
		const res = await cdp.evaluate(js, {awaitPromise: false});
		if (!res || !res.ok) {
			throw new Error(`could not install the recorder on the page: ${JSON.stringify(res).slice(0, 200)}`);
		}
		return res;
	}

	/** One drain. Silent about a dead socket; loud about a lost page. */
	async _recorderTick() {
		const r = this._recorder;
		if (!r) {
			return;
		}
		// `this.cdp` on purpose, never `_cdp()`: see the block comment above.
		const cdp = this.cdp;
		if (!cdp || !cdp.isOpen) {
			return;
		}
		if (cdp !== r.cdp) {
			// Connection identity, not a flag: the page-side recorder died with the old V8.
			r.timeline.markReattach(Date.now());
			r.cdp = cdp;
			const installed = await this._installRecorder(cdp, r.opts).catch(() => null);
			if (installed) {
				r.timeline.setClock(installed.t0, Date.now());
			}
			return;
		}
		const res = await cdp.evaluate(recorderDrainJs(), {awaitPromise: false}).catch(() => null);
		if (!res) {
			return;
		}
		if (res.gone) {
			// A navigation blew the global away; the buffer went with it.
			r.timeline.markReattach(Date.now());
			const installed = await this._installRecorder(cdp, r.opts).catch(() => null);
			if (installed) {
				r.timeline.setClock(installed.t0, Date.now());
			}
			return;
		}
		r.timeline.add(res.events, res.dropped);
		r.keysSeen = res.keys || r.keysSeen;
	}

	async recordStatus() {
		const r = this._recorder;
		if (!r) {
			return {ok: true, recording: false};
		}
		await this._recorderTick().catch(() => {});
		const page = this.cdp && this.cdp.isOpen
			? await this.cdp.evaluate(recorderStatusJs(), {awaitPromise: false}).catch(() => null)
			: null;
		return {
			ok: true, recording: true, device: this.cfg.id,
			elapsedMs: Date.now() - r.startedAt,
			keysSeen: r.keysSeen,
			observations: r.timeline.events.filter((e) => e.k === 'o').length,
			bufferDropped: r.timeline.dropped,
			reinstalls: r.timeline.reinstalls,
			badge: page ? !!page.badge : null,
			connected: !!(this.cdp && this.cdp.isOpen)
		};
	}

	/**
	 * @param {{title?: string, path?: string, overwrite?: boolean, note?: string,
	 *          assert?: string, longPressMs?: number, collapse?: boolean, watch?: Array<object>}} [opts]
	 */
	async recordStop(opts = {}) {
		const r = this._recorder;
		if (!r) {
			throw new Error(`no recording is running on "${this.cfg.id}" — start one with tv_record action:"start"`);
		}
		clearInterval(r.timer);
		r.timer = null;
		// One last drain while `_recorder` is still set, then take the page-side remains.
		await this._recorderTick().catch(() => {});
		this._recorder = null;
		if (this.cdp && this.cdp.isOpen) {
			const last = await this.cdp.evaluate(recorderStopJs(), {awaitPromise: false}).catch(() => null);
			if (last && !last.gone) {
				r.timeline.add(last.events, last.dropped);
				r.keysSeen = last.keys || r.keysSeen;
			}
		}

		const durationMs = Date.now() - r.startedAt;
		// An honest refusal beats an empty case that looks like a pass. This is the answer to
		// the open question about webOS 2: whether remote keys reach the page at all.
		if (!r.timeline.keyCount) {
			return {
				ok: false, written: false, durationMs, keys: 0,
				reason: 'no key events reached the page during the recording',
				hint: 'на этом движке клавиши пульта могут не доходить до webview (часть кнопок съедает лаунчер). ' +
					'Проверьте tv_record action:"status" во время нажатий.',
				warnings: [
					...(r.caseWarnings || []),
					...(r.timeline.reinstalls ? [`connection dropped ${r.timeline.reinstalls} time(s)`] : [])
				]
			};
		}

		// The profile's whitelist says what is worth asserting; the network log says what the
		// person's run actually produced. Only the intersection becomes a step — an assertion on
		// a request this scenario never made would be red on its first replay for a reason that
		// has nothing to do with the app.
		const declared = (opts.watch || (this.profile.record && this.profile.record.watch) || []);
		const watch = [];
		const unseen = [];
		for (const w of declared) {
			let count = 0;
			try {
				count = this._networkMatches({urlPattern: w.urlPattern, method: w.method}, r.startedAt).count;
			} catch (e) {
				count = 0;
			}
			if (count > 0) {
				watch.push(w);
			} else {
				unseen.push(w.name || w.urlPattern);
			}
		}

		const compiled = compileCase(r.timeline, this.profile, {
			platform: this.platform,
			assert: opts.assert || r.opts.assert || 'normal',
			longPressMs: opts.longPressMs || r.opts.longPressMs,
			collapse: opts.collapse !== undefined ? opts.collapse : r.opts.collapse,
			watch
		});
		if (unseen.length) {
			compiled.warnings.push(
				`no request matched ${unseen.map((x) => `"${x}"`).join(', ')} during the recording, so no assertion ` +
				'was written for it — the scenario may not be the one that fires it'
			);
		}
		const title = opts.title || `Запись с пульта (${this.cfg.id})`;
		this._pendingCase = {
			title, device: this.cfg.id, durationMs, note: opts.note,
			steps: compiled.steps, checklist: compiled.checklist,
			warnings: [...(r.caseWarnings || []), ...compiled.warnings],
			path: opts.path || null
		};
		// Nothing is written here, on purpose. A compiled case is a DRAFT: the steps are inferred
		// from what the person happened to press, and the one who can tell a real path from a
		// wrong turn is the person who pressed it. So `stop` shows the case and waits — the file
		// appears on action:"write", after a human has read it (and possibly edited the steps).
		const wouldWriteTo = this._casePath(this._pendingCase, {});
		return {
			ok: true, written: false, durationMs,
			keys: compiled.stats.keys, observations: compiled.stats.observations,
			dropped: compiled.stats.droppedPresses, reinstalls: compiled.stats.reinstalls,
			// Steps inline: this is what goes straight into tv_sequence to check the recording,
			// and it is 8-20 objects.
			steps: compiled.steps,
			checklist: compiled.checklist,
			...(this._pendingCase.warnings.length ? {warnings: this._pendingCase.warnings} : {}),
			// The exact file that action:"write" would produce — show THIS to the person, not a
			// retelling of it, or they are approving something other than what lands on disk.
			markdown: renderCase(this._pendingCase),
			wouldWriteTo,
			exists: existsSync(wouldWriteTo),
			next: 'на диск ничего не записано. Покажите кейс человеку и спросите: сохранить как есть, ' +
				'поправить (шаги/заголовок) или выбросить. Сохранить — tv_record action:"write" ' +
				'(можно с title, note, path, overwrite, steps).',
			replay: 'реплей не запускается сам: на живом ТВ он стартует плеер и шлёт аналитику. ' +
				'Скормите steps в tv_sequence, когда решите прогнать'
		};
	}

	/**
	 * Write the case `stop` compiled, once a human has approved it — optionally with edits.
	 * Editing goes through here rather than through a hand-written file so that the checklist and
	 * the warnings stay attached to the steps they belong to.
	 * @param {{path?: string, overwrite?: boolean, title?: string, note?: string,
	 *          steps?: Array<object>}} [opts]
	 */
	recordWrite(opts = {}) {
		if (!this._pendingCase) {
			throw new Error('nothing to write — there is no compiled case in this session (tv_record action:"stop" makes one, and a new "start" clears it)');
		}
		if (opts.title) {
			this._pendingCase.title = opts.title;
		}
		if (opts.note !== undefined) {
			this._pendingCase.note = opts.note;
		}
		if (opts.steps !== undefined) {
			if (!Array.isArray(opts.steps) || !opts.steps.length) {
				throw new Error('steps must be a non-empty array of tv_sequence steps');
			}
			for (const [i, st] of opts.steps.entries()) {
				if (!st || typeof st !== 'object' || Array.isArray(st) || !Object.keys(st).length) {
					throw new Error(`steps[${i}] is not a step object: ${JSON.stringify(st)}`);
				}
			}
			this._pendingCase.steps = opts.steps;
			// The checklist was compiled against the ORIGINAL steps. Saying so is cheaper than
			// recompiling it from steps a human wrote, and honest about what it now covers.
			if (!this._pendingCase.edited) {
				this._pendingCase.checklist = [
					...this._pendingCase.checklist,
					'шаги отредактированы вручную после компиляции — пункты выше относятся к исходной записи, перечитать'
				];
				this._pendingCase.edited = true;
			}
		}
		const written = this._writeCase(this._pendingCase, {path: opts.path, overwrite: opts.overwrite});
		if (written.written) {
			this._pendingCase.path = written.path;
		}
		return {ok: !!written.written, ...written, steps: this._pendingCase.steps, checklist: this._pendingCase.checklist};
	}

	/**
	 * Where a case would go. `stop` reports it, `_writeCase` uses it — one rule, so the path the
	 * human approves is the path that gets written.
	 * @param {object} c
	 * @param {{path?: string}} opts
	 * @return {string}
	 */
	_casePath(c, opts) {
		if (opts.path) {
			return resolve(opts.path);
		}
		if (c.path) {
			return resolve(c.path);
		}
		const dir = process.env.TV_DEBUG_CASES_DIR ? resolve(process.env.TV_DEBUG_CASES_DIR) : RECORDED_DIR;
		return join(dir, `${slugify(c.title)}.md`);
	}

	/**
	 * Write the markdown. A name collision is NOT resolved here — no silent suffix, no silent
	 * overwrite: the tool hands the conflict back and a human decides.
	 * @param {object} c
	 * @param {{path?: string, overwrite?: boolean}} opts
	 * @return {{written: boolean, path?: string, conflict?: string, warnings?: Array<string>}}
	 */
	_writeCase(c, opts) {
		const warnings = [];
		const outPath = this._casePath(c, opts);
		if (existsSync(outPath) && !opts.overwrite) {
			return {written: false, conflict: outPath};
		}
		const body = renderCase(c);
		try {
			mkdirSync(dirname(outPath), {recursive: true});
			writeFileSync(outPath, body, 'utf8');
			return {written: true, path: outPath, ...(warnings.length ? {warnings} : {})};
		} catch (e) {
			// A globally linked package sits in a read-only directory. Losing the compilation
			// over that would be absurd — fall back and say where it went.
			const fallback = join(resolve(process.env.TMPDIR || '/tmp'), `${slugify(c.title)}.md`);
			try {
				writeFileSync(fallback, body, 'utf8');
				warnings.push(`could not write to ${outPath} (${e.message}) — the case went to ${fallback} instead`);
				return {written: true, path: fallback, warnings};
			} catch (e2) {
				warnings.push(`could not write the case anywhere (${e.message}; ${e2.message}) — the steps above are the whole result`);
				return {written: false, warnings};
			}
		}
	}

	/** Compact focus signature — used to detect movement and loops. */
	async focusSignature() {
		return this._pageCall(focusSignatureJs(this.profile));
	}

	async videoState(sampleGapMs = 600) {
		const cdp = await this._cdp();
		const gap = Number(sampleGapMs) || 600;
		if (cdp.legacyEvalDialect) {
			// The legacy protocol ignores awaitPromise, so the promise-based expression would
			// come back as an unresolved, empty object. Same sampling — the gap just runs
			// host-side, and the second read reuses the element stashed by the first.
			//
			// The pair is stateful on the page, but this must NOT take the operation lock:
			// tv_sequence already holds it while running a {videoState:true} step, and the
			// lock is not reentrant. Concurrent samples are separated by a per-call token.
			const token = ++this._videoSampleSeq;
			const first = await cdp.evaluate(videoSampleStartJs(token), {awaitPromise: false});
			if (!first || !first.found) {
				return {found: (first && first.found) || 0};
			}
			await sleep(gap);
			const out = await cdp.evaluate(videoSampleFinishJs(token), {awaitPromise: false});
			// Never stamp `found` over the finish result: a lost sample reports found 0, and
			// overwriting it would hand back a video-shaped object with every field undefined
			// — which wait.js reads as a confident "not advancing".
			if (!out || out.sampleLost || !out.found) {
				return {found: first.found, sampleLost: true};
			}
			return out;
		}
		return cdp.evaluate(videoStateJs(gap), {awaitPromise: true, timeoutMs: gap + 5000});
	}

	async evaluate(expression, awaitPromise) {
		const cdp = await this._cdp();
		return cdp.evaluate(expression, {awaitPromise});
	}

	/**
	 * tv_evaluate: the value under a size cap. One `document.body.innerHTML` used to be 50k
	 * tokens of answer; the cut is reported and comes with a hint to narrow the expression.
	 * @param {string} expression
	 * @param {boolean} [awaitPromise]
	 */
	async evaluateCapped(expression, awaitPromise) {
		return capEvalValue(await this.evaluate(expression, awaitPromise));
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
	 * heavier after browsing" into a number. The full set needs Chromium 60+; an engine without
	 * the Performance domain (Chromium 47 and down) falls back to DOM counters and says so in a
	 * warning. Heap bytes are never faked from the quantized `performance.memory`.
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
		const fallback = await this._enableMetrics(cdp);
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
		if (fallback) {
			return this._domCounterMetrics(cdp, warnings);
		}
		let res;
		try {
			res = await cdp.call('Performance.getMetrics');
		} catch (e) {
			if (!isUnsupportedMethod(e)) {
				throw e;
			}
			// `enable` passed and `getMetrics` did not: still an engine without the domain.
			this._metricsFallbackFor = cdp;
			return this._domCounterMetrics(cdp, warnings);
		}
		const metrics = metricsToMap(res && res.metrics);
		if (!Object.keys(metrics).length) {
			warnings.push('the engine reported an empty metric list');
		}
		return {at: Date.now(), metrics, ...(warnings.length ? {warnings} : {})};
	}

	/**
	 * The metrics an engine without the `Performance` domain can still answer honestly.
	 *
	 * `Memory.getDOMCounters` exists far below Chromium 60 and gives the two numbers the leak
	 * scenario actually runs on — DOM nodes and event listeners. The names are the ones
	 * `Performance.getMetrics` uses, so a reading from this path and one from a modern TV go
	 * through the same `metricsDiff` and read the same in a report.
	 *
	 * What is deliberately NOT here: `JSHeapUsedSize`. The only source on these engines is
	 * page-side `performance.memory`, quantized to 100 KB — a fake steady number is worse than
	 * a missing one. Layout/style counters would have to come out of `Tracing` event counts,
	 * which is a different measurement wearing the same name.
	 * @param {CdpSession} cdp
	 * @param {Array<string>} warnings
	 * @return {Promise<{at: number, metrics: Object<string, *>, warnings: Array<string>}>}
	 */
	async _domCounterMetrics(cdp, warnings = []) {
		let res;
		try {
			res = await cdp.call('Memory.getDOMCounters');
		} catch (e) {
			throw this._metricsUnsupported(e, 'Performance.enable and Memory.getDOMCounters');
		}
		const metrics = {};
		const put = (name, value) => {
			if (typeof value === 'number' && Number.isFinite(value)) {
				metrics[name] = value;
			}
		};
		put('Nodes', res && res.nodes);
		put('Documents', res && res.documents);
		put('JSEventListeners', res && res.jsEventListeners);
		// `Timestamp` is what turns two readings into a rate (metrics.js windowSecondsOf). The
		// engine's own clock, in seconds, like the real metric — `performance.now()` counts from
		// navigation rather than engine start, which changes the absolute value and not the diff.
		const now = await cdp
			.evaluate('(function(){ try { return (window.performance && performance.now) ? performance.now() / 1000 : null; } catch (err) { return null; } })()',
				{awaitPromise: false})
			.catch(() => null);
		put('Timestamp', now);
		warnings.push(
			'Performance domain unavailable; DOM counters via Memory.getDOMCounters — ' +
			'Nodes/Documents/JSEventListeners and Timestamp only. No JSHeapUsedSize (the only source ' +
			'here is performance.memory, quantized to 100 KB) and no layout/style counters.'
		);
		return {at: Date.now(), metrics, warnings};
	}

	/**
	 * `Performance.enable` once per connection — getMetrics on a disabled domain answers with
	 * nothing on some engines instead of failing.
	 * @param {CdpSession} cdp
	 * @return {Promise<boolean>} true when this connection has no Performance domain and metrics
	 *   have to come from DOM counters instead
	 */
	async _enableMetrics(cdp) {
		if (this._metricsFallbackFor === cdp) {
			return true;
		}
		if (this._metricsEnabledFor === cdp) {
			return false;
		}
		try {
			await cdp.call('Performance.enable');
		} catch (e) {
			if (!isUnsupportedMethod(e)) {
				throw this._metricsUnsupported(e, 'Performance.enable');
			}
			this._metricsFallbackFor = cdp;
			return true;
		}
		this._metricsEnabledFor = cdp;
		return false;
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
				`${e.message}. The Performance domain needs Chromium 60+ and this engine has neither that nor ` +
				`Memory.getDOMCounters; tv_profile start/stop still records the CPU profile.`
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
	 * The connection for a network read. Deliberately NOT `_cdp()`: the request log lives in
	 * this process and outlives the page, so `list` has to answer for an app that has just
	 * died — which is usually when it is most wanted.
	 * @return {CdpSession}
	 */
	_networkCdp() {
		if (!this.cdp) {
			throw new Error(`device "${this.cfg.id}" is not launched — call tv_launch first`);
		}
		return this.cdp;
	}

	/**
	 * The buffered record for a requestId, newest first: a redirect chain reuses one requestId
	 * across hops, and the last hop is the one that has a body.
	 * @param {string} requestId
	 * @return {{record: ?object, hops: number}}
	 */
	_findRequest(requestId) {
		const all = this._networkCdp().network.filter((r) => r.requestId === requestId);
		return {record: all.length ? all[all.length - 1] : null, hops: all.length};
	}

	/**
	 * @param {object} filter
	 * @param {?number} since
	 * @return {{count: number, samples: Array<object>}}
	 */
	_networkMatches(filter, since) {
		const matched = selectRequests(this._networkCdp().network, {...filter, since});
		return {count: matched.length, samples: matched.slice(-5).map(toListEntry)};
	}

	/**
	 * Window start for an assertion: an explicit mark wins over the step's own start time —
	 * that is what `networkMark` is for, "match from here, not from this step".
	 * @param {number} startedAt
	 * @return {number}
	 */
	_networkSince(startedAt) {
		return this._networkMarkAt != null ? this._networkMarkAt : startedAt;
	}

	/** Move the assertion window to now. */
	networkMark() {
		this._networkMarkAt = Date.now();
		return {ok: true, markedAt: this._networkMarkAt};
	}

	/**
	 * The request log since launch, newest first.
	 * @param {{urlPattern?: string, method?: string, status?: *, since?: number, limit?: number}} [opts]
	 */
	networkList(opts = {}) {
		const cdp = this._networkCdp();
		const limit = Math.max(1, Math.floor(opts.limit || 25));
		const matched = selectRequests(cdp.network, {
			urlPattern: opts.urlPattern, method: opts.method, status: opts.status, since: opts.since
		});
		return {
			requests: matched.slice(-limit).reverse().map(toListEntry),
			matched: matched.length,
			buffered: cdp.network.length,
			// Eviction is the one way an assertion can be wrong without anybody noticing, so the
			// count travels with every answer.
			dropped: cdp.dropped.network,
			...(this._networkMarkAt != null ? {markedAt: this._networkMarkAt} : {})
		};
	}

	/**
	 * Read a response body back out of the engine.
	 *
	 * Bodies are NOT buffered on this side: they live in the engine's own buffer and are gone
	 * after a navigation or a relaunch. That is a property of the protocol, not a limitation to
	 * work around — the honest answer is "catch it with an expectRequest at the moment of the
	 * case", not a copy of every response body of the session.
	 * @param {string} requestId
	 */
	async networkBody(requestId) {
		if (!requestId) {
			throw new Error('tv_network action:"body" needs a `requestId` from action:"list"');
		}
		const id = String(requestId);
		const {record, hops} = this._findRequest(id);
		const cdp = await this._cdp();
		let res;
		try {
			res = await cdp.call('Network.getResponseBody', {requestId: id});
		} catch (e) {
			if (isUnsupportedMethod(e)) {
				throw new Error(
					`reading response bodies is not supported on this engine (${this.cfg.engine || this.platform}): ` +
					`Network.getResponseBody — ${e.message}`
				);
			}
			throw new Error(
				`the engine has no body for ${id} any more (${e.message}) — response bodies live in the engine ` +
				'buffer only until the page navigates or the app is relaunched, so they cannot be re-read later. ' +
				'Assert the body at the moment of the case with an expectRequest step instead.'
			);
		}
		const capped = capBody(res.body, !!res.base64Encoded);
		return {
			requestId: id,
			url: record ? record.url : null,
			status: record ? record.status : null,
			mimeType: record ? record.mimeType : null,
			base64Encoded: !!res.base64Encoded,
			bytes: capped.bytes,
			...(capped.truncated ? {truncated: true} : {}),
			...(hops > 1 ? {note: `${hops} redirect hops share this requestId — this is the body of the last one`} : {}),
			body: capped.body
		};
	}

	/**
	 * A runnable curl for one recorded request.
	 * @param {string} requestId
	 * @param {{raw?: boolean}} [opts]
	 */
	async networkCurl(requestId, opts = {}) {
		if (!requestId) {
			throw new Error('tv_network action:"curl" needs a `requestId` from action:"list"');
		}
		const id = String(requestId);
		const cdp = this._networkCdp();
		const {record, hops} = this._findRequest(id);
		if (!record) {
			throw new Error(
				`no request ${id} in the buffer (${cdp.dropped.network} evicted since launch) — take a fresh action:"list"`
			);
		}
		if (record.postDataPending && cdp.isOpen) {
			// Chromium 62+ keeps a large body out of the event and hands it back on demand.
			const got = await cdp.call('Network.getRequestPostData', {requestId: id}).catch(() => null);
			if (got && typeof got.postData === 'string') {
				record.postData = got.postData.slice(0, MAX_POSTDATA_BYTES);
				record.postDataTruncated = got.postData.length > record.postData.length;
				record.postDataPending = false;
			}
		}
		const built = buildCurl(record, {raw: !!opts.raw, postDataLimit: MAX_POSTDATA_BYTES});
		const warnings = [...built.warnings];
		if (hops > 1) {
			warnings.push(`${hops} redirect hops share this requestId — this is the last one; curl follows redirects itself with -L`);
		}
		return {requestId: id, url: record.url, method: record.method, command: built.command, warnings};
	}

	/**
	 * Write the filtered log as a HAR 1.2 file — importable into DevTools → Network, Charles or
	 * Insomnia, and the ready proof attachment for a bug report.
	 *
	 * Bodies are best-effort and only "now": `getResponseBody` reads the engine buffer, so a HAR
	 * taken at the end of the case has them and one taken after a relaunch does not. Entries
	 * without a body carry a comment saying so, and `bodiesMissing` counts them.
	 * @param {{path?: string, urlPattern?: string, method?: string, status?: *, since?: number,
	 *          withBodies?: boolean}} [opts]
	 */
	async networkHar(opts = {}) {
		const cdp = this._networkCdp();
		const matched = selectRequests(cdp.network, {
			urlPattern: opts.urlPattern, method: opts.method, status: opts.status, since: opts.since
		});
		if (!matched.length) {
			throw new Error('no buffered request matched the filter — nothing to write; check with action:"list" first');
		}
		const warnings = [];
		const bodies = new Map();
		let included = 0;
		let missing = 0;
		let bodyBytes = 0;
		if (opts.withBodies !== false) {
			if (!cdp.isOpen) {
				warnings.push('the connection is gone, so the HAR has metadata only — bodies can only be read from a live engine');
			} else {
				for (const rec of matched) {
					// Nothing to ask for: a failed request, a redirect hop and an unanswered
					// request have no response body by definition.
					if (rec.failed || rec.redirectedTo || rec.status == null) {
						continue;
					}
					if (bodyBytes >= HAR_BODY_TOTAL_LIMIT) {
						warnings.push(`stopped reading bodies at ${Math.round(HAR_BODY_TOTAL_LIMIT / (1024 * 1024))}MB — the rest of the entries are metadata only`);
						break;
					}
					const res = await cdp.call('Network.getResponseBody', {requestId: rec.requestId})
						.catch((e) => ({__error: e.message}));
					if (!res || res.__error || typeof res.body !== 'string') {
						missing++;
						bodies.set(rec.seq, {error: res && res.__error ? res.__error : 'no body returned'});
						continue;
					}
					const capped = capBody(res.body, !!res.base64Encoded);
					bodyBytes += capped.body.length;
					bodies.set(rec.seq, {
						body: capped.body, base64Encoded: !!res.base64Encoded, truncated: capped.truncated
					});
					included++;
				}
			}
		}
		const har = buildHar(matched, {bodies, version: PKG_VERSION, withBodies: opts.withBodies !== false});
		const outPath = opts.path
			? resolve(opts.path)
			: resolve(process.env.TMPDIR || '/tmp', `tv-network-${this.cfg.id}-${Date.now()}.har`);
		const json = JSON.stringify(har);
		writeFileSync(outPath, json);
		return {
			ok: true,
			path: outPath,
			bytes: Buffer.byteLength(json),
			entries: har.log.entries.length,
			bodiesIncluded: included,
			bodiesMissing: missing,
			...(warnings.length ? {warning: warnings.join('; ')} : {})
		};
	}

	/**
	 * Wait until a condition holds. See wait.js for the condition shapes.
	 *
	 * The state snapshot is opt-in (`withState`): every `expect` of a sequence used to pay a
	 * round-trip and 300-600 bytes for a state nobody read.
	 * @param {object} condition
	 * @param {{timeoutMs?: number, intervalMs?: number, stableMs?: number, startedAt?: number,
	 *          withState?: boolean}} [opts]
	 */
	async waitFor(condition, opts = {}) {
		if (condition && condition.request) {
			return this.waitForRequest(condition.request, opts);
		}
		// Named forms ({element} / {elementGone} / {sceneName}) are folded into the raw ones
		// here rather than in the tool handler, so tv_sequence steps get them for free.
		const {condition: cond, resolvedFrom} = resolveCondition(this.profile, condition);
		const tick = this._tick();
		const io = {
			evaluate: (js) => this._pageCall(js),
			videoState: (gap) => this.videoState(gap)
		};
		const res = await pollUntil(io, this.profile, cond, opts);
		const out = {...res, ...(resolvedFrom ? {resolvedFrom} : {}), evals: this._cost(tick).evals};
		if (opts.withState) {
			out.state = await this.state().catch(() => null);
		}
		return out;
	}

	/**
	 * Assert on the network log. No state snapshot rides along on purpose: this answer is about
	 * what went over the wire, and it has to stay readable when the page is already gone.
	 * @param {object} cond see pollRequests
	 * @param {{timeoutMs?: number, intervalMs?: number, startedAt?: number}} [opts]
	 */
	async waitForRequest(cond, opts = {}) {
		const startedAt = opts.startedAt != null ? opts.startedAt : Date.now();
		const since = cond.since != null ? Number(cond.since) : this._networkSince(startedAt);
		const io = {networkMatches: (c) => this._networkMatches(c, since)};
		const res = await pollRequests(io, cond, {
			timeoutMs: cond.timeoutMs != null ? cond.timeoutMs : opts.timeoutMs,
			intervalMs: opts.intervalMs
		});
		return {...res, since, dropped: this._networkCdp().dropped.network};
	}

	/**
	 * Press a direction until the FOCUSED element matches the target.
	 *
	 * Bounded three ways, because an unbounded "press until it looks right" loop on a TV is
	 * how you burn ten minutes: `maxSteps`, a wall-clock `deadlineMs`, and two structural
	 * stops — focus that stopped moving (edge of a list) and focus that returned to a
	 * position we already visited (a carousel that wraps).
	 * @param {{direction: string, element?: string, text?: string, selector?: string, testid?: string,
	 *          select?: boolean, maxSteps?: number, deadlineMs?: number}} opts
	 */
	async goto(opts) {
		const {target, resolvedFrom} = resolveTarget(this.profile, opts);
		const res = await this._gotoTarget({...target, ref: opts.ref}, opts);
		if (resolvedFrom) {
			// Echo what the name actually became: a red case has to name the selector it
			// really checked, otherwise the indirection is a debugging tax.
			res.resolvedFrom = resolvedFrom;
		}
		// Arriving and selecting is one intent and two round-trips otherwise, and the pause
		// between them is where a lazily-loading list moves the focus out from under you.
		if (res.ok && opts.select) {
			await this._press('ENTER');
			res.selected = true;
			res.state = await this.state().catch(() => null);
		}
		return res;
	}

	/**
	 * One page-side call per step: press + settle + "is this the target" (see _press). The
	 * green answer is a trail ("DOWN×3") and the final focus; the per-press `steps` list only
	 * comes back with a red one, where it is the evidence.
	 * @param {{text: ?string, selector: ?string, testid: ?string, ref?: string}} target
	 * @param {{direction: string, maxSteps?: number, deadlineMs?: number}} opts
	 */
	async _gotoTarget(target, opts) {
		const direction = String(opts.direction || '').toUpperCase();
		if (!direction) {
			throw new Error('tv_goto needs a direction (UP / DOWN / LEFT / RIGHT)');
		}
		if (target.ref == null && target.text == null && target.selector == null && target.testid == null) {
			throw new Error('tv_goto needs a target: ref, element, text, selector or testid');
		}
		const tick = this._tick();
		const maxSteps = Math.min(200, Math.max(1, Math.floor(opts.maxSteps || 30)));
		const deadline = Date.now() + (opts.deadlineMs || 45000);
		// A ref is checked by IDENTITY (focusLeaf() === the stashed element), which is strictly
		// stronger than matching text: duplicate titles in a catalog are normal, and a text
		// match silently stops on the wrong tile.
		const matchBody = target.ref != null
			? focusIsRefBody(target.ref)
			: focusMatchesBody(target);
		const steps = [];
		const seen = new Set();
		const done = (ok, presses, extra) => {
			const out = {ok, presses, ...extra, ...this._cost(tick)};
			if (ok) {
				if (presses > 0) {
					out.trail = `${direction}×${presses}`;
				}
			} else {
				out.steps = steps;
			}
			return out;
		};

		const first = await this._pageCall(sigAndMatchJs(this.profile, matchBody));
		let match = first.match || {};
		// A stale ref must fail here, not after thirty presses in the wrong direction.
		if (match.refMissing) {
			return done(false, 0, {reason: match.reason});
		}
		if (match.ok) {
			return done(true, 0, {reason: 'already on target', focus: match.detail});
		}
		let sig = first.sig;
		seen.add(sig);

		for (let i = 0; i < maxSteps; i++) {
			if (Date.now() > deadline) {
				return done(false, i, {reason: 'deadline reached', focus: match.detail});
			}
			const r = await this._press(direction, {before: sig, matchBody});
			match = r.match || {};
			const nextSig = r.after;
			steps.push({press: direction, focus: match.detail ? match.detail.text : null, matched: !!match.ok});

			if (match.refMissing) {
				// The page navigated under us and took the ref store with it.
				return done(false, i + 1, {reason: match.reason});
			}
			if (match.ok) {
				return done(true, i + 1, {focus: match.detail});
			}
			if (nextSig === sig) {
				return done(false, i + 1, {reason: `focus stopped moving on ${direction} (edge of the list?)`, focus: match.detail});
			}
			if (seen.has(nextSig)) {
				return done(false, i + 1, {reason: 'focus returned to a position already visited (wrapped around)', focus: match.detail});
			}
			seen.add(nextSig);
			sig = nextSig;
		}
		return done(false, maxSteps, {reason: `target not reached in ${maxSteps} presses`, focus: match.detail});
	}

	/**
	 * Move focus into the app's menu and pick a section by name. Needs a `menu` block in the
	 * app profile — that is the app-specific knowledge the MCP itself must not hard-code.
	 * @param {?string} name section title (omit to just open the menu and list the items)
	 * @param {{select?: boolean, maxOpenPresses?: number, deadlineMs?: number}} [opts]
	 */
	async menu(name, opts = {}) {
		const menu = requireMenu(this.profile);
		const tick = this._tick();
		// Reaching the sidebar takes one press per column you are away from it, so a fixed
		// small count fails as soon as the case has navigated a few tiles right. Press until
		// focus is inside the menu, bounded the same way tv_goto is.
		const maxOpen = Math.min(50, Math.max(1, Math.floor(opts.maxOpenPresses || 20)));
		const openPresses = [];
		// One call for the opening read: the state (is the focus in the menu already?) and the
		// signature the first press compares against.
		let st = await this.state({withSig: true});
		let sig = st.sig;
		delete st.sig;
		let inMenu = !!st.focusInMenu;
		let seen = new Set([sig]);
		// Some screens don't let the open key cross back to the sidebar at all — inside a
		// settings-style section LEFT can do nothing and you have to leave with BACK first.
		// One such escape press, then carry on; without it tv_menu is only usable from the
		// catalog.
		let escapesLeft = menu.exitKey ? 1 : 0;
		const inMenuBody = focusInMenuBody(menu);

		for (let i = 0; i < maxOpen && !inMenu; i++) {
			// Press + settle + "is the focus inside the menu now" — one round-trip.
			const r = await this._press(menu.openKey, {before: sig, matchBody: inMenuBody});
			const m = r.match || {};
			inMenu = !!m.ok;
			openPresses.push({press: menu.openKey, focus: m.detail ? m.detail.text : null, focusInMenu: inMenu});
			if (inMenu) {
				break;
			}
			if (r.after === sig || seen.has(r.after)) {
				if (escapesLeft > 0) {
					escapesLeft--;
					const esc = await this._press(menu.exitKey, {matchBody: inMenuBody});
					const em = esc.match || {};
					inMenu = !!em.ok;
					sig = esc.after;
					seen = new Set([sig]);
					openPresses.push({press: menu.exitKey, focus: em.detail ? em.detail.text : null, focusInMenu: inMenu, note: 'escape from the section'});
					continue;
				}
				return {
					ok: false,
					reason: `focus stopped moving on ${menu.openKey} before reaching the menu`,
					openPresses,
					state: await this.state().catch(() => st),
					...this._cost(tick)
				};
			}
			seen.add(r.after);
			sig = r.after;
		}
		if (!inMenu) {
			return {
				ok: false,
				reason: `focus did not reach the menu within ${maxOpen}x ${menu.openKey}`,
				openPresses,
				state: await this.state().catch(() => st),
				...this._cost(tick)
			};
		}
		const items = await this._pageCall(menuItemsJs(this.profile)).catch(() => []);
		if (!name) {
			return {ok: true, opened: true, items, state: await this.state(), ...this._cost(tick)};
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
			return {ok: false, reason: `menu item "${name}" not found`, items, goto: res, state: await this.state(), ...this._cost(tick)};
		}
		const select = opts.select !== false;
		if (select) {
			await this._press('ENTER');
		}
		return {
			ok: true, chosen: name, items, selected: select,
			presses: openPresses.length + res.presses,
			state: await this.state(),
			...this._cost(tick)
		};
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
		const full = opts.report === 'full';
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
					result = await this._runStep(step, t0);
					if (result && result.ok === false) {
						ok = false;
					}
				} catch (e) {
					ok = false;
					result = {error: e.message};
				}
				const row = {i, step: stepLabel(step), ok, ms: Date.now() - t0};
				// A green navigation step is one line; a reading and a red step keep their result
				// — that is the evidence a verdict is written from.
				const keep = full || !ok || READ_STEPS.some((k) => step[k] !== undefined);
				if (keep) {
					row.result = result;
				} else {
					const brief = stepBrief(step, result);
					if (brief) {
						row.brief = brief;
					}
				}
				out.push(row);
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

	/**
	 * @param {object} step
	 * @param {number} [startedAt] when this step began — the default network assertion window
	 */
	async _runStep(step, startedAt = Date.now()) {
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
			return this.waitFor(step.expect, {
				timeoutMs: step.timeoutMs != null ? step.timeoutMs : 5000, stableMs: step.stableMs, startedAt
			});
		}
		if (step.expectRequest) {
			// The assertion the console buffer could never make: "the request went out, and it
			// carried the field". Window = this step, unless a networkMark moved it earlier.
			return this.waitForRequest(step.expectRequest, {
				timeoutMs: step.timeoutMs, intervalMs: step.intervalMs, startedAt
			});
		}
		if (step.networkMark !== undefined) {
			return this.networkMark();
		}
		if (step.eval != null) {
			return {ok: true, ...(await this.evaluateCapped(step.eval, true))};
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
		if (step.snapshot !== undefined) {
			// So a case can take the structural read at a checkpoint, under the operation lock,
			// instead of racing a separate tv_snapshot call against its own steps.
			const o = step.snapshot && typeof step.snapshot === 'object' ? step.snapshot : {};
			return this.snapshot(o);
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
			'launch, press, longpress, goto, menu, wait, expect, expectRequest, networkMark, eval, ' +
			'sleep, videoState, state, snapshot, profileStart, profileStop, metrics'
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
	 * Console output, exceptions and failed requests since launch — deduplicated.
	 *
	 * A TV app that throws the same exception on every focus move produces sixty identical
	 * 1.4 KB entries; one entry with `count` and first/last timestamps says the same thing.
	 * Timestamps are seconds since the connection was made (`t`, `tLast`), file urls are cut
	 * to their basename (`at`). The entries reported are the most recent distinct ones.
	 * @param {{filter?: string, levels?: Array<string>, limit?: number}} [opts]
	 */
	consoleReport({filter, levels, limit = 30} = {}) {
		if (!this.cdp) {
			throw new Error(`device "${this.cfg.id}" is not launched — call tv_launch first`);
		}
		const cdp = this.cdp;
		const take = Math.max(1, Math.floor(limit) || 30);
		const needle = filter ? String(filter).toLowerCase() : null;
		const matchText = (s) => !needle || String(s || '').toLowerCase().includes(needle);
		const wantLevel = (m) => !levels || !levels.length || levels.includes(m.level);
		const t0 = cdp.startedAt || 0;
		const rel = (at) => (typeof at === 'number' && t0 ? Math.round((at - t0) / 100) / 10 : null);
		const basename = (url) => {
			if (!url) {
				return null;
			}
			const u = String(url);
			const cut = u.indexOf('?');
			const path = cut >= 0 ? u.slice(0, cut) : u;
			return path.slice(path.lastIndexOf('/') + 1) || path;
		};
		/**
		 * Newest distinct entries, chronological, each with how often it repeated.
		 * @param {Array<object>} list
		 * @param {function(object): string} keyOf
		 * @param {function(object): object} shape
		 */
		const dedup = (list, keyOf, shape) => {
			const byKey = new Map();
			for (const m of list) {
				const k = keyOf(m);
				const hit = byKey.get(k);
				if (hit) {
					hit.count++;
					hit.tLast = rel(m.at);
				} else {
					byKey.set(k, {...shape(m), count: 1, t: rel(m.at), tLast: rel(m.at)});
				}
			}
			const rows = [...byKey.values()].slice(-take);
			for (const r of rows) {
				if (r.count === 1) {
					delete r.count;
					delete r.tLast;
				}
				if (r.t === null) {
					delete r.t;
					delete r.tLast;
				}
			}
			return rows;
		};
		const place = (m) => {
			const file = basename(m.url);
			return file ? {at: m.line != null ? `${file}:${m.line}` : file} : {};
		};
		return {
			errors: dedup(
				cdp.exceptions.filter((m) => matchText(m.text)),
				(m) => m.text,
				(m) => ({text: m.text, ...place(m)})
			),
			console: dedup(
				cdp.console.filter((m) => wantLevel(m) && matchText(m.text)),
				(m) => `${m.level}\u0000${m.text}`,
				(m) => ({level: m.level, text: m.text, ...place(m)})
			),
			networkFailures: dedup(
				cdp.networkFailures.filter((n) => matchText(n.url) || matchText(n.errorText)),
				(n) => `${n.url}\u0000${n.errorText}\u0000${n.blocked}`,
				(n) => ({url: n.url, errorText: n.errorText, ...(n.blocked ? {blocked: n.blocked} : {})})
			),
			totals: {
				console: cdp.console.length,
				exceptions: cdp.exceptions.length,
				networkFailures: cdp.networkFailures.length,
				// Failures are what this tool has always reported; the full log (successful
				// requests, bodies, assertions) is tv_network's job.
				networkRequests: cdp.network.length
			},
			droppedFromBuffer: cdp.dropped
		};
	}

	/**
	 * The tv_launch answer: what an agent needs to drive this device, once. Everything about
	 * the transport (ws url, device port) stays in the log.
	 * @param {?object} page
	 */
	launchReport(page) {
		const p = page || {};
		const out = {
			ok: true,
			device: this.cfg.id,
			engine: this.cfg.engine,
			url: p.href,
			title: p.title,
			inputMode: this.input.mode,
			freshLaunch: !!p.freshLaunch
		};
		if (p.localPort) {
			out.localPort = p.localPort;
		}
		if (this.cdp && this.cdp.rttMs != null) {
			out.rttMs = this.cdp.rttMs;
		}
		if (this.cdp && this.cdp.legacyEvalDialect) {
			out.legacyEval = true;
		}
		for (const k of ['bootReady', 'warning', 'reloadSkipped']) {
			if (p[k] !== undefined) {
				out[k] = p[k];
			}
		}
		return out;
	}

	async dispose() {
		// A recording left running would keep a REC badge on screen and listeners on an app that
		// outlives this process. Take it down while the socket is still alive.
		if (this._recorder) {
			clearInterval(this._recorder.timer);
			this._recorder = null;
			if (this.cdp && this.cdp.isOpen) {
				await this.cdp.evaluate(recorderStopJs(), {awaitPromise: false}).catch(() => {});
			}
		}
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
