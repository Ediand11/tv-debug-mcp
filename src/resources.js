// tv_resources — CPU and memory of the whole TV and of the app under test, sampled on the TV
// itself (webOS and Tizen). This is the half the CDP side cannot see: tv_profile/tv_heap report
// the JS heap and the DOM, while the renderer's RSS also holds decoded images, layer textures and
// <video> buffers, and the TV's free memory is what decides when the system kills the app.
//
// Tizen has no resource monitor to drive, but the app can read its own /proc through
// `tizen.filesystem.openFile` (Tizen 5.0+; the older `resolve().readAsText` returns '' on /proc,
// XHR on file:///proc fails). So there the sampler is a host timer doing one Runtime.evaluate per
// tick over the app's CDP session — see the Tizen section at the bottom.
//
// webOS: same data source as LG's Resource Monitor GUI: `ares-device --resource-monitor` keeps one
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
 * @param {?function(string): Promise<*>} [evaluate] Tizen only: runs JS in the app's page
 */
export async function resourcesStart(cfg, opts = {}, evaluate = null) {
	if (cfg.platform !== 'webos' && cfg.platform !== 'tizen') {
		throw new Error(`tv_resources supports webOS and Tizen only; "${cfg.id}" is ${cfg.platform}. For JS heap / DOM use tv_profile action:"metrics" or tv_heap`);
	}
	const running = monitors.get(cfg.id);
	if (running) {
		throw new Error(`a resource monitor is already running on "${cfg.id}" since ${new Date(running.startedAt).toISOString()} — read or stop it first`);
	}
	const intervalSec = opts.intervalSec === undefined
		? (cfg.platform === 'tizen' ? TIZEN_DEFAULT_INTERVAL_SEC : 1)
		: Number(opts.intervalSec);
	if (!(intervalSec >= MIN_INTERVAL_SEC && intervalSec <= MAX_INTERVAL_SEC)) {
		throw new Error(`intervalSec must be ${MIN_INTERVAL_SEC}..${MAX_INTERVAL_SEC}, got ${opts.intervalSec}`);
	}
	const appId = opts.appId || cfg.appId;
	if (cfg.platform === 'tizen') {
		// /proc/self is whatever app the CDP session is attached to — an appId override would
		// only relabel it.
		return tizenStart(cfg, cfg.appId, intervalSec, evaluate);
	}
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
	const mon = monitorFor(cfg);
	return mon.tizen ? tizenReport(mon, true) : report(mon, {running: true});
}

export async function resourcesStop(cfg) {
	const mon = monitorFor(cfg);
	if (mon.tizen) {
		await stopMonitor(mon);
		return tizenReport(mon, false);
	}
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
	if (mon.tizen) {
		clearInterval(mon.tizen.timer);
		return;
	}
	await Promise.all([stopChild(mon.system.proc), stopChild(mon.app.proc)]);
}

// --- Tizen ---------------------------------------------------------------------------------
//
// One Runtime.evaluate per tick returns the raw text of the app's own /proc files and of the
// Mali GPU table; the host parses it (pure, tested offline). Checked on Tizen 5.5 and 8.0:
// - PSS comes from /proc/self/smaps_rollup — Tizen 8 has it, 5.5 does not. Summing
//   /proc/self/smaps instead is ~8 MB of text per read, not something for a timer, so on 5.5
//   PSS is simply missing.
// - GPU memory is not in the process's smaps at all: /sys/kernel/debug/mali0/gpu_memory lists
//   it per pid, in KB. It is reported next to RSS/PSS because that is where Tizen video and
//   texture growth shows up.
// - CPU % is utime+stime of /proc/self/stat against the aggregate `cpu` line of /proc/stat, both
//   in clock ticks — a share of ALL cores, like ares on webOS. The first sample has no CPU.
// - Other processes' /proc/<pid> are closed to the app, so this is the app plus system totals.
// The read runs on the app's main thread (a few tens of KB of text), hence the 2 s default, and
// timestamps are the host clock.

const TIZEN_DEFAULT_INTERVAL_SEC = 2;

const TIZEN_FILES = [
	['status', '/proc/self/status', 4000],
	['stat', '/proc/self/stat', 1000],
	['cpu', '/proc/stat', 300],
	['meminfo', '/proc/meminfo', 6000],
	['gpu', '/sys/kernel/debug/mali0/gpu_memory', 20000],
	['rollup', '/proc/self/smaps_rollup', 3000]
];

/** Page-side, ES5. A file that cannot be read comes back null: PSS and GPU are optional. */
export const TIZEN_READ_JS = '(function(){var fs=window.tizen&&tizen.filesystem;' +
	'if(!fs||!fs.openFile)return JSON.stringify({noOpenFile:true});' +
	'var f=' + JSON.stringify(TIZEN_FILES) + ',o={},i,h;' +
	'for(i=0;i<f.length;i++){h=null;' +
	'try{h=fs.openFile(f[i][1],"r");o[f[i][0]]=h.readString(f[i][2]);}catch(e){o[f[i][0]]=null;}' +
	'if(h){try{h.close();}catch(e){}}}' +
	'return JSON.stringify(o);})()';

/** `Name:   123 kB` / `Pid:	123` → 123 */
function procField(text, name) {
	const m = new RegExp(`^${name}:\\s*(\\d+)`, 'm').exec(text || '');
	return m ? +m[1] : null;
}

/**
 * The app's row of mali0/gpu_memory: `name  pid  gpu_mem  max_gpu_mem  [tid]`, KB. The leftmost
 * run of three numbers is pid/gpu/max whether or not the trailing column is there.
 * @param {?string} text
 * @param {?number} pid
 * @return {?number}
 */
export function maliGpuKb(text, pid) {
	if (!text || pid === null) {
		return null;
	}
	for (const line of text.split('\n')) {
		const m = /\s(\d+)\s+(\d+)\s+(\d+)(?:\s+\d+)?\s*$/.exec(line);
		if (m && +m[1] === pid) {
			return +m[2];
		}
	}
	return null;
}

/**
 * One tick of TIZEN_READ_JS output → numbers (KB, clock ticks).
 * @param {Object<string, ?string>} raw
 * @param {string} time `YYYY-MM-DD HH:MM:SS`
 */
export function parseTizenSample(raw, time) {
	const status = raw.status || '';
	const mem = raw.meminfo || '';
	const pid = procField(status, 'Pid');
	const memTotalKb = procField(mem, 'MemTotal');
	const memAvailableKb = procField(mem, 'MemAvailable');
	const swapTotal = procField(mem, 'SwapTotal');
	const swapFree = procField(mem, 'SwapFree');
	// user nice system idle iowait irq softirq steal; guest time is already inside user
	const cpuLine = /^cpu\s+(.*)$/m.exec(raw.cpu || '');
	const cpu = cpuLine ? cpuLine[1].trim().split(/\s+/).map(Number) : [];
	// comm may hold spaces and parens, so fields are counted from the last ')': utime and stime
	// are fields 14 and 15, i.e. 11 and 12 after it (state is field 3)
	const stat = raw.stat || '';
	const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
	return {
		time, pid,
		rssKb: procField(status, 'VmRSS'),
		swapKb: procField(status, 'VmSwap'),
		pssKb: procField(raw.rollup, 'Pss'),
		pssAnonKb: procField(raw.rollup, 'Pss_Anon'),
		gpuKb: maliGpuKb(raw.gpu, pid),
		appTicks: rest.length > 12 ? +rest[11] + +rest[12] : null,
		cpuTotal: cpu.length >= 4 ? cpu.slice(0, 8).reduce((a, b) => a + b, 0) : null,
		cpuIdle: cpu.length >= 4 ? cpu[3] + (cpu[4] || 0) : null,
		memTotalKb, memAvailableKb,
		memUsedKb: memTotalKb !== null && memAvailableKb !== null ? memTotalKb - memAvailableKb : null,
		swapUsedKb: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null,
		cmaFreeKb: procField(mem, 'CMAFree')
	};
}

/**
 * The answer of read/stop on Tizen, in the webOS shape plus pssMb/pssAnonMb/gpuMb/swapMb (app)
 * and cmaFreeMb (system — the pool the hardware video decoder allocates from).
 * @param {{samples: Array<object>, appId: string}} input parseTizenSample outputs, in order
 */
export function summarizeTizen({samples, appId}) {
	const t = samples.map((s, i) => {
		const p = samples[i - 1];
		const dt = p && s.cpuTotal !== null && p.cpuTotal !== null ? s.cpuTotal - p.cpuTotal : 0;
		return {
			...s,
			cpuPct: dt > 0 ? round(100 * (dt - (s.cpuIdle - p.cpuIdle)) / dt) : null,
			appCpuPct: dt > 0 && s.pid === p.pid && s.appTicks !== null && p.appTicks !== null
				? round(100 * (s.appTicks - p.appTicks) / dt)
				: null
		};
	});
	const pids = [...new Set(t.map((s) => s.pid).filter((p) => p !== null))];
	const last = t[t.length - 1];
	const out = {
		window: t.length ? {from: t[0].time, to: last.time} : null,
		system: {
			samples: t.length,
			memTotalMb: last && last.memTotalKb !== null ? round(last.memTotalKb / 1024) : null,
			cpuPct: seriesStats(t, 'cpuPct'),
			memAvailableMb: seriesStats(t, 'memAvailableKb', 1024),
			memUsedMb: seriesStats(t, 'memUsedKb', 1024),
			swapUsedMb: seriesStats(t, 'swapUsedKb', 1024),
			cmaFreeMb: seriesStats(t, 'cmaFreeKb', 1024)
		},
		app: {
			id: appId,
			samples: t.length,
			pids,
			cpuPct: seriesStats(t, 'appCpuPct'),
			rssMb: seriesStats(t, 'rssKb', 1024),
			pssMb: seriesStats(t, 'pssKb', 1024),
			pssAnonMb: seriesStats(t, 'pssAnonKb', 1024),
			gpuMb: seriesStats(t, 'gpuKb', 1024),
			swapMb: seriesStats(t, 'swapKb', 1024)
		}
	};
	const warnings = [];
	if (pids.length > 1) {
		warnings.push(`${appId} changed pid during the window (${pids.join(' → ')}): the app was restarted or killed — figures span two processes`);
	}
	if (t.length && out.app.pssMb === null) {
		warnings.push('no /proc/self/smaps_rollup on this firmware (Tizen 5.5 has none, 8.0 has) — pssMb is missing, RSS and GPU are not');
	}
	if (t.length && out.app.gpuMb === null) {
		warnings.push('no GPU figure: /sys/kernel/debug/mali0/gpu_memory is not readable here or has no row for the app pid');
	}
	if (warnings.length) {
		out.warnings = warnings;
	}
	return out;
}

const hostTime = () => {
	const d = new Date();
	return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * @param {object} mon
 * @param {boolean} [strict] throw instead of counting the failure — the first tick, inside start
 */
async function tizenTick(mon, strict = false) {
	const t = mon.tizen;
	if (t.busy) {
		return; // a slow TV: skip the tick rather than pile evaluates up
	}
	t.busy = true;
	try {
		const raw = JSON.parse(await t.evaluate(TIZEN_READ_JS));
		if (raw.noOpenFile) {
			throw new Error('tizen.filesystem.openFile is missing — reading /proc from the page needs Tizen 5.0+');
		}
		if (!raw.status) {
			throw new Error('/proc/self/status is not readable from the page');
		}
		t.samples.push(parseTizenSample(raw, hostTime()));
	} catch (e) {
		if (strict) {
			throw e;
		}
		t.failed++;
		t.lastError = e.message;
	} finally {
		t.busy = false;
	}
}

async function tizenStart(cfg, appId, intervalSec, evaluate) {
	if (!evaluate) {
		throw new Error('tv_resources on Tizen reads the app page over CDP, but no page session was given');
	}
	const mon = {
		deviceId: cfg.id, appId, intervalSec, startedAt: Date.now(),
		tizen: {timer: null, samples: [], failed: 0, lastError: null, busy: false, evaluate}
	};
	// Claimed before the first await so two concurrent starts cannot both pass the check.
	monitors.set(cfg.id, mon);
	try {
		await tizenTick(mon, true);
	} catch (e) {
		if (monitors.get(cfg.id) === mon) {
			monitors.delete(cfg.id);
		}
		throw new Error(`resource monitor did not start on "${cfg.id}": ${e.message}`);
	}
	if (monitors.get(cfg.id) !== mon) {
		// stop arrived during the first tick: arming the timer now would orphan it
		throw new Error(`resource monitor on "${cfg.id}" was stopped while starting`);
	}
	mon.tizen.timer = setInterval(() => tizenTick(mon), intervalSec * 1000);
	mon.tizen.timer.unref();
	const now = mon.tizen.samples[0];
	const mb = (kb) => (kb === null ? null : round(kb / 1024));
	return {
		ok: true, device: cfg.id, appId, intervalSec,
		now: {
			memAvailableMb: mb(now.memAvailableKb), memTotalMb: mb(now.memTotalKb),
			rssMb: mb(now.rssKb), pssMb: mb(now.pssKb), gpuMb: mb(now.gpuKb)
		},
		note: 'sampling over the app\'s CDP session; act, then tv_resources read (keeps going) or stop'
	};
}

function tizenReport(mon, running) {
	const t = mon.tizen;
	const summary = summarizeTizen({samples: t.samples, appId: mon.appId});
	if (t.failed) {
		// A TV that went away mid-window leaves a summary that silently ends early — say so.
		summary.warnings = [...(summary.warnings || []), `${t.failed} sample(s) failed, last: ${t.lastError}`];
	}
	return {
		ok: true, device: mon.deviceId, intervalSec: mon.intervalSec,
		elapsedSec: Math.round((Date.now() - mon.startedAt) / 1000),
		running,
		...summary
	};
}

/** For server shutdown: no ares-device (and its SSH session to the TV) outlives the MCP. */
export async function stopAllResourceMonitors() {
	await Promise.all([...monitors.values()].map(stopMonitor));
}

// Any other way out (stdin closed, process.exit elsewhere) skips the async cleanup; a plain
// kill is synchronous and still allowed in an 'exit' handler.
process.on('exit', () => {
	for (const mon of monitors.values()) {
		if (mon.tizen) {
			continue; // a host timer, gone with the process
		}
		for (const c of [mon.system, mon.app]) {
			try {
				c.proc.kill('SIGTERM');
			} catch {
				// already gone
			}
		}
	}
});
