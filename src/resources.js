// tv_resources — CPU and memory of the whole TV and of the app under test, sampled on the TV
// itself (webOS only). This is the half the CDP side cannot see: tv_profile/tv_heap report the
// JS heap and the DOM, while the renderer's RSS also holds decoded images, layer textures and
// <video> buffers, and the TV's free memory is what decides when the system kills the app.
//
// Same data source as LG's Resource Monitor GUI: `ares-device --resource-monitor` keeps one
// dev-mode SSH session and reads /proc/stat, /proc/<pid>/stat, `ps` and `free -k` every
// interval; the app's pid comes from `applicationManager/dev/running` (`webprocessid` for a
// web app). ares prints the system and the per-app view in separate modes, so two children are
// kept: `-r` and `-r -id <appId>`, each appending to its own CSV. A single remote loop would need
// our own SSH client — `ares-shell -r` returns the first chunk of output and hangs up.
//
// Numbers as ares computes them: CPU % is a share of ALL cores (100 = every core busy), the app's
// memory is RSS (stat field 24 × 4 KB), system memory is `free -k`. Timestamps have one-second
// resolution (`date` on the TV). The process-mode sampler cats every /proc/<pid>/stat on each
// tick, so it costs the TV some CPU itself — it lands in the system figure, not the app's.
//
// The parsers and the summary are pure (no spawn, no clock) and tested offline.

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

import {stopChild} from './adapters/spawn-until-match.js';

/** First system sample lands ~1.1 s after the SSH session is up; the session itself takes a few. */
const FIRST_SAMPLE_TIMEOUT_MS = 20000;
const POLL_MS = 250;
/** Enough of a child's output to quote the ares error ("Connection timed out…"). */
const TAIL_BYTES = 1500;
const MIN_INTERVAL_SEC = 1;
const MAX_INTERVAL_SEC = 60;

const TIME_RE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;

/** @type {Map<string, Monitor>} one live monitor per device id */
const monitors = new Map();

/**
 * @typedef {{
 *   deviceId: string, appId: string, intervalSec: number, startedAt: number,
 *   system: Child, app: Child
 * }} Monitor
 * @typedef {{proc: import('node:child_process').ChildProcess, csv: string, out: string, error: ?string}} Child
 */

/**
 * Minimal CSV line splitter: csv-writer (what ares uses) quotes a field only when it holds a
 * comma, a quote or a newline, and doubles quotes inside.
 * @param {string} line
 * @return {Array<string>}
 */
export function splitCsvLine(line) {
	const out = [];
	let cur = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quoted) {
			if (c === '"' && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (c === '"') {
				quoted = false;
			} else {
				cur += c;
			}
		} else if (c === '"') {
			quoted = true;
		} else if (c === ',') {
			out.push(cur);
			cur = '';
		} else {
			cur += c;
		}
	}
	out.push(cur);
	return out;
}

const num = (s) => (s === undefined || s === '' ? null : (Number.isFinite(+s) ? +s : null));

/** Data rows only: the header (and anything else ares may write) does not start with a timestamp. */
function dataRows(text) {
	return String(text || '').split(/\r?\n/).map(splitCsvLine).filter((c) => TIME_RE.test(c[0]));
}

/**
 * The `ares-device -r -s` CSV: per tick, one row per CPU (`cpu`, `cpu0`…; columns 1-5) and one
 * row per memory line (`memory`, `buffers`, `swap`; columns 6-12). Columns:
 * time,(%),overall,usermode,kernelmode,others,(KB),total,used,free,shared,buff/cache,available
 *
 * `available` exists only with a new-format `free`; an old one prints buffers/cached and a
 * "-/+ buffers/cache" line instead, whose `free` is the same idea — that is the fallback.
 *
 * A tick starts at its aggregate `cpu` row, NOT at a new timestamp: the ares timer drifts, and
 * on webOS 7 two ticks landed in one second (11:46:31 skipped, 11:46:32 twice) — grouping by
 * time merged them.
 * @param {string} text
 * @return {Array<{time: string, cpuPct: ?number, memTotalKb: ?number, memUsedKb: ?number, memFreeKb: ?number, memAvailableKb: ?number, swapUsedKb: ?number}>}
 */
export function parseSystemCsv(text) {
	const ticks = [];
	let s = null;
	for (const c of dataRows(text)) {
		if (!s || c[1] === 'cpu' || s.time !== c[0]) {
			s = {time: c[0], cpuPct: null, memTotalKb: null, memUsedKb: null, memFreeKb: null, memAvailableKb: null, swapUsedKb: null, _buffersFree: null};
			ticks.push(s);
		}
		if (c[1] === 'cpu') {
			s.cpuPct = num(c[2]);
		}
		if (c[6] === 'memory') {
			s.memTotalKb = num(c[7]);
			s.memUsedKb = num(c[8]);
			s.memFreeKb = num(c[9]);
			s.memAvailableKb = num(c[12]);
		} else if (c[6] === 'buffers') {
			s._buffersFree = num(c[9]);
		} else if (c[6] === 'swap') {
			s.swapUsedKb = num(c[8]);
		}
	}
	return ticks.map(({_buffersFree, ...t}) => ({
		...t,
		memAvailableKb: t.memAvailableKb !== null ? t.memAvailableKb : _buffersFree
	}));
}

/**
 * The `ares-device -r -id <appId> -s` CSV: time,PID,ID,DISPLAY ID,CPU(%),MEMORY(%),MEMORY(KB).
 * Rows of other ids are dropped; two processes of one id in one tick (two displays) are summed.
 * A tick ends when the time changes or a pid of the current tick shows up again — the same
 * second can hold two ticks (see parseSystemCsv), and summing those doubled the RSS.
 * @param {string} text
 * @param {string} appId
 * @return {Array<{time: string, pids: Array<number>, cpuPct: ?number, rssKb: ?number}>}
 */
export function parseAppCsv(text, appId) {
	const ticks = [];
	let s = null;
	for (const c of dataRows(text)) {
		if (c[2] !== appId) {
			continue;
		}
		const pid = num(c[1]);
		if (!s || s.time !== c[0] || (pid !== null && s.pids.includes(pid))) {
			s = {time: c[0], pids: [], cpuPct: null, rssKb: null};
			ticks.push(s);
		}
		if (pid !== null) {
			s.pids.push(pid);
		}
		const cpu = num(c[4]);
		const rss = num(c[6]);
		if (cpu !== null) {
			s.cpuPct = (s.cpuPct || 0) + cpu;
		}
		if (rss !== null) {
			s.rssKb = (s.rssKb || 0) + rss;
		}
	}
	return ticks;
}

const round = (n, d = 1) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

/**
 * min/max/avg over a series plus where it started and ended — `delta` is the growth over the
 * window, `maxAt` the tick of the peak. `scale` converts on the way out (KB → MB).
 * @param {Array<object>} samples
 * @param {string} key
 * @param {number} [scale]
 * @return {?{min: number, max: number, avg: number, first: number, last: number, delta: number, maxAt: string}}
 */
export function seriesStats(samples, key, scale = 1) {
	const pts = samples.filter((s) => typeof s[key] === 'number');
	if (!pts.length) {
		return null;
	}
	let min = pts[0], max = pts[0], sum = 0;
	for (const p of pts) {
		if (p[key] < min[key]) {
			min = p;
		}
		if (p[key] > max[key]) {
			max = p;
		}
		sum += p[key];
	}
	const v = (x) => round(x / scale);
	return {
		min: v(min[key]), max: v(max[key]), avg: v(sum / pts.length),
		first: v(pts[0][key]), last: v(pts[pts.length - 1][key]),
		delta: v(pts[pts.length - 1][key] - pts[0][key]),
		maxAt: max.time.slice(11)
	};
}

/**
 * The answer of read/stop, from the two CSV texts. Memory is reported in MB.
 * @param {{systemCsv: string, appCsv: string, appId: string}} input
 */
export function summarizeResources({systemCsv, appCsv, appId}) {
	const sys = parseSystemCsv(systemCsv);
	const app = parseAppCsv(appCsv, appId);
	const pids = [];
	for (const s of app) {
		for (const p of s.pids) {
			if (!pids.includes(p)) {
				pids.push(p);
			}
		}
	}
	const window = sys.length ? {from: sys[0].time, to: sys[sys.length - 1].time} : null;
	const out = {
		window,
		system: {
			samples: sys.length,
			memTotalMb: sys.length ? round(sys[sys.length - 1].memTotalKb / 1024) : null,
			cpuPct: seriesStats(sys, 'cpuPct'),
			memAvailableMb: seriesStats(sys, 'memAvailableKb', 1024),
			memUsedMb: seriesStats(sys, 'memUsedKb', 1024),
			swapUsedMb: seriesStats(sys, 'swapUsedKb', 1024)
		},
		app: {
			id: appId,
			samples: app.length,
			pids,
			cpuPct: seriesStats(app, 'cpuPct'),
			rssMb: seriesStats(app, 'rssKb', 1024)
		}
	};
	const warnings = [];
	if (!app.length) {
		warnings.push(`no samples for ${appId}: it was not running, or applicationManager/dev/running does not list it (ares only resolves apps it can see there)`);
	}
	if (pids.length > 1) {
		warnings.push(`${appId} changed pid during the window (${pids.join(' → ')}): the app was restarted or killed — RSS figures span two processes`);
	}
	if (sys.length && out.system.memAvailableMb === null) {
		warnings.push('this `free` reports neither `available` nor a buffers/cache line — memAvailableMb is missing');
	}
	if (warnings.length) {
		out.warnings = warnings;
	}
	return out;
}

/**
 * @param {import('./config.js').DeviceConfig} cfg
 * @param {Array<string>} extra
 * @param {string} csv
 * @return {Child}
 */
function spawnMonitor(cfg, extra, csv) {
	const args = ['-r', ...extra, '-s', csv, ...(cfg.device ? ['-d', cfg.device] : [])];
	const child = {proc: null, csv, out: '', error: null};
	const keep = (buf) => {
		child.out = (child.out + buf.toString()).slice(-TAIL_BYTES);
	};
	const proc = spawn('ares-device', args, {stdio: ['ignore', 'pipe', 'pipe']});
	// Without an 'error' listener a missing ares CLI (ENOENT) would take the whole MCP down.
	proc.on('error', (e) => {
		child.error = e.code === 'ENOENT' ? 'ares-device not found — install @webos-tools/cli' : e.message;
	});
	proc.stdout.on('data', keep);
	proc.stderr.on('data', keep);
	child.proc = proc;
	return child;
}

const alive = (c) => !!c.proc && c.proc.exitCode === null && !c.proc.signalCode && !c.error;
// eslint-disable-next-line no-control-regex
const clean = (s) => s.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, '').trim();
const readCsv = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

function childNote(c) {
	if (c.error) {
		return c.error;
	}
	if (!alive(c)) {
		return `ares-device exited (${c.proc.exitCode ?? c.proc.signalCode}): ${clean(c.out).slice(-400)}`;
	}
	return null;
}

/**
 * @param {import('./config.js').DeviceConfig} cfg
 * @param {{appId?: string, intervalSec?: number, path?: string}} [opts]
 */
export async function resourcesStart(cfg, opts = {}) {
	if (cfg.platform !== 'webos') {
		throw new Error(`tv_resources is webOS-only (it drives \`ares-device --resource-monitor\` over the dev-mode SSH); "${cfg.id}" is ${cfg.platform}. For JS heap / DOM use tv_profile action:"metrics" or tv_heap`);
	}
	const running = monitors.get(cfg.id);
	if (running) {
		throw new Error(`a resource monitor is already running on "${cfg.id}" since ${new Date(running.startedAt).toISOString()} — read or stop it first`);
	}
	const intervalSec = opts.intervalSec === undefined ? 1 : Number(opts.intervalSec);
	if (!(intervalSec >= MIN_INTERVAL_SEC && intervalSec <= MAX_INTERVAL_SEC)) {
		throw new Error(`intervalSec must be ${MIN_INTERVAL_SEC}..${MAX_INTERVAL_SEC}, got ${opts.intervalSec}`);
	}
	const appId = opts.appId || cfg.appId;
	const dir = resolve(opts.path || process.env.TMPDIR || '/tmp');
	mkdirSync(dir, {recursive: true});
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const base = join(dir, `tv-res-${cfg.id}-${stamp}`);

	const mon = {
		deviceId: cfg.id, appId, intervalSec, startedAt: Date.now(),
		system: spawnMonitor(cfg, ['-t', String(intervalSec)], base + '-system.csv'),
		app: spawnMonitor(cfg, ['-id', appId, '-t', String(intervalSec)], base + '-app.csv')
	};
	monitors.set(cfg.id, mon);

	// Hold the call until the first system sample is on disk: an unreachable TV or a dev-mode
	// session that expired has to fail HERE, not surface as an empty summary a minute later.
	const deadline = Date.now() + FIRST_SAMPLE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (parseSystemCsv(readCsv(mon.system.csv)).length) {
			break;
		}
		if (!alive(mon.system)) {
			const note = childNote(mon.system);
			await stopMonitor(mon);
			throw new Error(`resource monitor did not start on "${cfg.id}": ${note}`);
		}
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
	const sys = parseSystemCsv(readCsv(mon.system.csv));
	if (!sys.length) {
		const tail = clean(mon.system.out).slice(-400);
		await stopMonitor(mon);
		throw new Error(`no sample from "${cfg.id}" within ${FIRST_SAMPLE_TIMEOUT_MS / 1000}s${tail ? ': ' + tail : ''}`);
	}
	const now = sys[sys.length - 1];
	return {
		ok: true, device: cfg.id, appId, intervalSec,
		csv: {system: mon.system.csv, app: mon.app.csv},
		now: {
			cpuPct: now.cpuPct,
			memAvailableMb: round(now.memAvailableKb === null ? null : now.memAvailableKb / 1024),
			memTotalMb: round(now.memTotalKb === null ? null : now.memTotalKb / 1024)
		},
		note: 'sampling in the background; act, then tv_resources read (keeps going) or stop'
	};
}

function monitorFor(cfg) {
	const mon = monitors.get(cfg.id);
	if (!mon) {
		throw new Error(`no resource monitor running on "${cfg.id}" — tv_resources action:"start" first`);
	}
	return mon;
}

function report(mon, extra) {
	const summary = summarizeResources({
		systemCsv: readCsv(mon.system.csv), appCsv: readCsv(mon.app.csv), appId: mon.appId
	});
	const dead = [['system', mon.system], ['app', mon.app]]
		.map(([name, c]) => [name, childNote(c)])
		.filter(([, n]) => n);
	if (dead.length && !extra.stopped) {
		// A sampler that died mid-window (TV off, SSH dropped) leaves a summary that silently
		// ends early — say so.
		summary.warnings = [...(summary.warnings || []), ...dead.map(([name, n]) => `${name} sampler stopped: ${n}`)];
	}
	return {
		ok: true, device: mon.deviceId, intervalSec: mon.intervalSec,
		elapsedSec: Math.round((Date.now() - mon.startedAt) / 1000),
		...extra,
		...summary,
		csv: {system: mon.system.csv, app: mon.app.csv}
	};
}

/** Summary so far; the samplers keep running. */
export function resourcesRead(cfg) {
	return report(monitorFor(cfg), {running: true});
}

export async function resourcesStop(cfg) {
	const mon = monitorFor(cfg);
	const notes = [childNote(mon.system), childNote(mon.app)];
	await stopMonitor(mon);
	const out = report(mon, {running: false, stopped: true});
	delete out.stopped;
	const died = notes.filter(Boolean);
	if (died.length) {
		out.warnings = [...(out.warnings || []), ...died.map((n) => `a sampler had stopped before stop: ${n}`)];
	}
	return out;
}

async function stopMonitor(mon) {
	monitors.delete(mon.deviceId);
	await Promise.all([stopChild(mon.system.proc), stopChild(mon.app.proc)]);
}

/** For server shutdown: no ares-device (and its SSH session to the TV) outlives the MCP. */
export async function stopAllResourceMonitors() {
	await Promise.all([...monitors.values()].map(stopMonitor));
}

// Any other way out (stdin closed, process.exit elsewhere) skips the async cleanup; a plain
// kill is synchronous and still allowed in an 'exit' handler.
process.on('exit', () => {
	for (const mon of monitors.values()) {
		for (const c of [mon.system, mon.app]) {
			try {
				c.proc.kill('SIGTERM');
			} catch {
				// already gone
			}
		}
	}
});
