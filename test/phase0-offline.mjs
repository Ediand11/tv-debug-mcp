// Phase-0 acceptance that needs no TV: config handling, failure isolation and the CPU-profile
// parser (which is pure and therefore fully testable without a device).
//
//   1. a device that is not connected reports an honest status (it used to say "connected"
//      for everything, because "List of devices attached" contains the word "device")
//   2. editing devices.json is picked up without restarting the MCP
//   3. an invalid config fails the call, not the process
//   4. a missing `sdb` binary fails one tool call, not the process
//   5. summarizeProfile agrees on both wire formats (Chromium 62+ and Chrome 38), keeps V8
//      book-keeping frames out of the hot list, and does not double-count recursion
//   6. applySourceMap de-minifies the top frames, and a broken map degrades to a warning
//   7. the getMetrics parser keeps every metric both readings had and never invents a number
//
// Run: node test/phase0-offline.mjs
import {spawn} from 'node:child_process';
import {writeFileSync, readFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {SourceMapGenerator} from 'source-map-js';

import {summarizeProfile, applySourceMap} from '../src/profile.js';
import {metricsToMap, metricsDiff, windowSecondsOf} from '../src/metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'src', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
	if (ok) {
		passed++;
		console.log(`  PASS  ${name}`);
	} else {
		failed++;
		console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
	}
};

const dir = mkdtempSync(join(tmpdir(), 'tv-debug-cfg-'));
const cfgPath = join(dir, 'devices.json');
const writeCfg = (obj) => writeFileSync(cfgPath, JSON.stringify(obj, null, 2));

writeCfg({
	defaultDevice: 'ghost',
	devices: [
		{id: 'ghost', platform: 'tizen', name: 'Not plugged in', appId: 'x.y', host: '10.255.255.1', sdbPort: 26101}
	]
});

function startServer(env) {
	const child = spawn('node', [serverPath], {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, ...env}});
	let id = 0;
	let buf = '';
	const pending = new Map();
	child.stdout.on('data', (chunk) => {
		buf += chunk.toString();
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) {
				continue;
			}
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.id && pending.has(msg.id)) {
				pending.get(msg.id)(msg);
				pending.delete(msg.id);
			}
		}
	});
	child.stderr.resume();
	const rpc = (method, params) => new Promise((res) => {
		const myId = ++id;
		pending.set(myId, res);
		child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: myId, method, params}) + '\n');
	});
	const call = async (name, args = {}) => {
		const r = await rpc('tools/call', {name, arguments: args});
		const text = r.result?.content?.[0]?.text;
		if (r.result?.isError) {
			return {__error: text};
		}
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	};
	const ready = (async () => {
		await sleep(400);
		await rpc('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'offline', version: '0'}});
		child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
	})();
	return {child, call, ready, alive: () => child.exitCode === null, stop: () => child.kill('SIGTERM')};
}

const loadProfile = (name) =>
	JSON.parse(readFileSync(join(__dirname, 'fixture', 'profiles', name), 'utf8'));

/** 5 + 6: the profile parser, no server and no device involved. */
function profileChecks() {
	console.log('\n--- CPU profile parser ---');
	const modern = summarizeProfile(loadProfile('modern.cpuprofile.json'));
	const legacy = summarizeProfile(loadProfile('legacy.cpuprofile.json'));

	check('modern profile is recognised as modern', modern.format === 'modern', modern.format);
	check('legacy head-tree profile is recognised as legacy', legacy.format === 'legacy', legacy.format);

	for (const [label, sum] of [['modern', modern], ['legacy', legacy]]) {
		check(`${label}: recording length is 100ms`, sum.totalMs === 100, String(sum.totalMs));
		check(`${label}: average sample interval is 1ms`, sum.sampleIntervalMs === 1, String(sum.sampleIntervalMs));
		check(`${label}: sample count comes from the samples array`, sum.sampleCount === 10, String(sum.sampleCount));

		const top = sum.topFunctions[0];
		check(`${label}: hottest function is busyLoop with 40ms self / 40%`,
			top?.name === 'busyLoop' && top?.selfMs === 40 && top?.selfPct === 40,
			JSON.stringify(top));
		check(`${label}: busyLoop total time includes its child (60ms)`, top?.totalMs === 60, String(top?.totalMs));
		check(`${label}: helper is second with 20ms`,
			sum.topFunctions[1]?.name === 'helper' && sum.topFunctions[1]?.selfMs === 20,
			JSON.stringify(sum.topFunctions[1]));
		check(`${label}: V8 book-keeping frames stay out of topFunctions`,
			!sum.topFunctions.some((f) => /^\(/.test(f.name)),
			sum.topFunctions.map((f) => f.name).join(','));
		check(`${label}: program/gc/idle are reported separately (10/10/20)`,
			sum.special.programMs === 10 && sum.special.gcMs === 10 && sum.special.idleMs === 20,
			JSON.stringify(sum.special));
		check(`${label}: topFiles aggregates the script to 60ms`,
			sum.topFiles[0]?.url === 'http://tv.local/app.js' && sum.topFiles[0]?.selfMs === 60,
			JSON.stringify(sum.topFiles[0]));
		// The two formats disagree on the base of lineNumber; the summary must not.
		check(`${label}: line numbers are reported 1-based, as DevTools shows them`,
			top?.line === 10, String(top?.line));
	}

	const rec = summarizeProfile(loadProfile('recursive.cpuprofile.json'));
	check('recursion: one entry for the recursive function', rec.topFunctions.length === 1,
		JSON.stringify(rec.topFunctions.map((f) => f.name)));
	check('recursion: self time is the sum of all its frames (40ms)', rec.topFunctions[0]?.selfMs === 40,
		String(rec.topFunctions[0]?.selfMs));
	check('recursion: total time is counted once, not per level (40ms, not 90ms)',
		rec.topFunctions[0]?.totalMs === 40, String(rec.topFunctions[0]?.totalMs));

	let broke = null;
	try {
		summarizeProfile({samples: [], timeDeltas: []});
	} catch (e) {
		broke = e.message;
	}
	check('a profile with neither nodes nor head is rejected with a clear message',
		!!broke && /unrecognised CPU profile shape/.test(broke), broke);

	// --- source maps ---
	const mapDir = mkdtempSync(join(tmpdir(), 'tv-debug-map-'));
	const mapPath = join(mapDir, 'app.js.map');
	const gen = new SourceMapGenerator({file: 'app.js'});
	// The modern fixture puts busyLoop at 0-based 9:4, i.e. 1-based line 10, column 5.
	gen.addMapping({generated: {line: 10, column: 4}, original: {line: 3, column: 0}, source: 'src/scroll.js', name: 'scrollTick'});
	gen.addMapping({generated: {line: 20, column: 1}, original: {line: 88, column: 2}, source: 'src/measure.js', name: 'measureRow'});
	writeFileSync(mapPath, gen.toString());

	const mapped = summarizeProfile(loadProfile('modern.cpuprofile.json'));
	const res = applySourceMap(mapped, mapPath);
	check('source map applies to the top frames', res.ok && res.mapped === 2, JSON.stringify(res));
	check('the minified name is replaced by the original one',
		mapped.topFunctions[0]?.name === 'scrollTick' && mapped.topFunctions[0]?.url === 'src/scroll.js',
		JSON.stringify(mapped.topFunctions[0]));
	check('the original position is reported',
		mapped.topFunctions[0]?.line === 3, String(mapped.topFunctions[0]?.line));
	check('what was on the device is kept under `minified`',
		mapped.topFunctions[0]?.minified?.name === 'busyLoop' && mapped.topFunctions[0]?.minified?.line === 10,
		JSON.stringify(mapped.topFunctions[0]?.minified));

	const intact = summarizeProfile(loadProfile('modern.cpuprofile.json'));
	const failed = applySourceMap(intact, join(mapDir, 'does-not-exist.map'));
	check('an unreadable map degrades to a warning', !failed.ok && /source map failed/.test(failed.warning),
		failed.warning);
	check('the summary survives a failed map', intact.topFunctions[0]?.name === 'busyLoop',
		JSON.stringify(intact.topFunctions[0]?.name));
}

/** 7: the metrics parser, pure like the profile one — no server, no device. */
function metricsChecks() {
	console.log('\n--- Performance.getMetrics ---');

	const before = metricsToMap([
		{name: 'Timestamp', value: 1000.5},
		{name: 'Nodes', value: 1200},
		{name: 'JSEventListeners', value: 340},
		{name: 'JSHeapUsedSize', value: 20000000},
		{name: 'LayoutDuration', value: 0.1},
		{name: 'GoneMetric', value: 7},
		{name: 'Mode', value: 'timeTicks'},
		// Junk an engine has no business sending, but which must not become a key either way.
		null,
		{name: '', value: 1},
		{value: 3}
	]);
	check('metricsToMap turns the CDP array into a plain object',
		before.Nodes === 1200 && before.JSHeapUsedSize === 20000000, JSON.stringify(before));
	check('entries without a usable name are dropped', Object.keys(before).length === 7,
		Object.keys(before).join(','));
	check('a reading that is not an array yields an empty map',
		Object.keys(metricsToMap(undefined)).length === 0 && Object.keys(metricsToMap(null)).length === 0);

	const after = metricsToMap([
		{name: 'Timestamp', value: 1012.25},
		{name: 'Nodes', value: 1650},
		{name: 'JSEventListeners', value: 352},
		{name: 'JSHeapUsedSize', value: 24500000},
		{name: 'LayoutDuration', value: 0.4},
		{name: 'Mode', value: 'timeTicks'},
		{name: 'NewMetric', value: 5}
	]);
	const diff = metricsDiff(before, after);

	check('diff reports before/after/diff per metric',
		diff.Nodes?.before === 1200 && diff.Nodes?.after === 1650 && diff.Nodes?.diff === 450,
		JSON.stringify(diff.Nodes));
	check('cumulative Duration counters diff without float noise (0.4 - 0.1 = 0.3)',
		diff.LayoutDuration?.diff === 0.3, String(diff.LayoutDuration?.diff));
	check('a metric only the first reading had survives with a null diff',
		diff.GoneMetric?.after === null && diff.GoneMetric?.diff === null, JSON.stringify(diff.GoneMetric));
	check('a metric only the second reading had survives too',
		diff.NewMetric?.before === null && diff.NewMetric?.after === 5, JSON.stringify(diff.NewMetric));
	check('non-numeric values are passed through, not subtracted',
		diff.Mode?.after === 'timeTicks' && diff.Mode?.diff === null, JSON.stringify(diff.Mode));
	check('every metric of both readings is reported (no whitelist)',
		Object.keys(diff).length === 8, Object.keys(diff).join(','));
	check('the window length comes from the engine Timestamp',
		windowSecondsOf(diff) === 11.75, String(windowSecondsOf(diff)));
	check('no Timestamp means no invented window',
		windowSecondsOf(metricsDiff({Nodes: 1}, {Nodes: 2})) === null);
	check('an empty pair of readings diffs to nothing instead of throwing',
		Object.keys(metricsDiff(null, undefined)).length === 0);
}

async function main() {
	profileChecks();
	metricsChecks();

	console.log('\n--- config and failure isolation ---');
	// A PATH with node but no `sdb`/`tizen`, so tool calls have to fail gracefully.
	const s = startServer({TV_DEBUG_CONFIG: cfgPath, PATH: dirname(process.execPath)});
	await s.ready;

	const d1 = await s.call('tv_devices');
	check('offline device is not reported as connected',
		d1.devices?.[0]?.status !== 'device' && d1.devices?.[0]?.status !== 'connected',
		`status=${d1.devices?.[0]?.status}`);
	check('config path is reported', !!d1.configPath, d1.configPath);

	// 2. hot reload
	writeCfg({
		defaultDevice: 'ghost',
		devices: [
			{id: 'ghost', platform: 'tizen', name: 'Not plugged in', appId: 'x.y', host: '10.255.255.1'},
			{id: 'laptop', platform: 'pc', name: 'Chrome on this laptop', url: 'http://localhost:1337'}
		]
	});
	await sleep(50);
	const d2 = await s.call('tv_devices');
	check('devices.json edit is picked up without a restart',
		(d2.devices || []).some((x) => x.id === 'laptop'),
		(d2.devices || []).map((x) => x.id).join(','));

	// 3. invalid config
	writeCfg({devices: [{id: 'dup', platform: 'tizen', appId: 'a', host: '1.2.3.4'}, {id: 'dup', platform: 'tizen', appId: 'a', host: '1.2.3.5'}]});
	await sleep(50);
	const bad = await s.call('tv_devices');
	check('duplicate ids are rejected with a clear error',
		!!bad.__error && /duplicate device id/.test(bad.__error), bad.__error);
	check('server survived the bad config', s.alive());

	// 4. missing sdb
	writeCfg({defaultDevice: 'ghost', devices: [{id: 'ghost', platform: 'tizen', appId: 'x.y', host: '10.255.255.1'}]});
	await sleep(50);
	const launch = await s.call('tv_launch', {});
	check('tv_launch without sdb fails the call', !!launch.__error, String(launch.__error).slice(0, 120));
	check('server survived a missing sdb binary', s.alive());

	const after = await s.call('tv_devices');
	check('server still answers after the failure', Array.isArray(after.devices));

	const badAction = await s.call('tv_profile', {action: 'heap'});
	check('tv_profile rejects an unknown action and names the real ones',
		!!badAction.__error && /"start", "stop" or "metrics"/.test(badAction.__error), badAction.__error);

	s.stop();
	console.log(`\n${passed} passed, ${failed} failed\n`);
	process.exit(failed ? 1 : 0);
}

main().catch((e) => {
	console.error('phase0-offline crashed:', e);
	process.exit(2);
});
