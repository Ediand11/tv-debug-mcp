// Phase-2 acceptance: the same tool surface driving a local Chrome instead of a TV.
//
//   1. tv_devices reports pc capabilities honestly (no install, screenshot yes)
//   2. tv_install on a pc device is refused with a useful message, not a fake no-op
//   3. tv_launch starts OUR Chrome (own throwaway profile, port 0) and loads the URL
//   4. the navigation tools work unchanged: wait_for / state / goto / menu / sequence
//   5. screenshots produce real pixels here (they hang on Tizen's secure video plane)
//   6. the parity device (inputMode: synthetic) drives the app through the SAME event path
//      as the TV, and every press says which mode produced it
//   7. a missing dev server is an actionable error, not a hang
//   8. tv_profile records real CPU samples, names the hot function, and refuses double
//      start / orphan stop; profileStart/profileStop also work as sequence steps
//   9. tv_profile metrics: a standalone reading, a before/after/diff around a recording that
//      actually sees DOM growth, collectGarbage, and `metrics` as a sequence step
//  10. tv_heap: a real snapshot on disk, a constructor summary of it, a diff that names a
//      planted leak and its detached DOM nodes, and a refusal to snapshot mid-recording
//  11. dispose kills our Chrome and leaves the server alone
//
// It runs against test/fixture/index.html on a throwaway static server, so it does not need
// a product dev server. Point TV_DEV_URL at your own dev server and TV_DEV_APP at its profile
// in apps/ to exercise the real app in the same run as a bonus.
//
// Run: node test/phase2-check.mjs
import {spawn} from 'node:child_process';
import {writeFileSync, mkdtempSync, existsSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';

import {startServer, makeChecker, sleep} from './harness.mjs';
import {loadAppProfile} from '../src/appprofile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const check = makeChecker();

function freePort() {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.on('error', rej);
		srv.listen(0, '127.0.0.1', () => {
			const {port} = srv.address();
			srv.close(() => res(port));
		});
	});
}

async function urlUp(url) {
	try {
		const res = await fetch(url, {signal: AbortSignal.timeout(3000)});
		return res.ok;
	} catch {
		return false;
	}
}

function chromeCount() {
	return new Promise((res) => {
		const p = spawn('bash', ['-lc', 'pgrep -f "tv-debug-chrome-" | wc -l']);
		let out = '';
		p.stdout.on('data', (c) => (out += c));
		p.on('exit', () => res(parseInt(out.trim(), 10) || 0));
	});
}

async function main() {
	const port = await freePort();
	const fixtureUrl = `http://127.0.0.1:${port}`;
	const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
		{cwd: join(__dirname, 'fixture'), stdio: 'ignore'});
	const stopFixture = () => {
		try {
			http.kill('SIGTERM');
		} catch {
			// ignore
		}
	};
	process.on('exit', stopFixture);

	for (let i = 0; i < 40 && !(await urlUp(fixtureUrl)); i++) {
		await sleep(150);
	}
	if (!(await urlUp(fixtureUrl))) {
		console.log('\nSKIP: could not start the fixture static server\n');
		stopFixture();
		process.exit(3);
	}

	// Optional bonus run against the caller's own app. Both variables are needed: the URL of
	// their dev server and the id of its profile in apps/.
	const devUrl = process.env.TV_DEV_URL || '';
	const devApp = process.env.TV_DEV_APP || '';
	const devProfile = devApp ? loadAppProfile(devApp) : null;
	const devTile = devProfile?.bootReady?.selector || devProfile?.tile || '';
	const devUp = !!(devUrl && devTile) && (await urlUp(devUrl));
	const dir = mkdtempSync(join(tmpdir(), 'tv-debug-pc-'));
	const cfgPath = join(dir, 'devices.json');
	const devices = [
		{id: 'pc-fixture', platform: 'pc', name: 'Chrome + fixture', app: 'fixture', url: fixtureUrl},
		{id: 'pc-parity', platform: 'pc', name: 'Chrome + fixture, TV-identical input', app: 'fixture', url: fixtureUrl, inputMode: 'synthetic'},
		{id: 'pc-dead', platform: 'pc', name: 'Chrome + a server that is not there', app: 'fixture', url: 'http://127.0.0.1:1'}
	];
	if (devUp) {
		devices.push({id: 'pc-app', platform: 'pc', name: 'Chrome + your dev server', app: devApp, url: devUrl});
	}
	writeFileSync(cfgPath, JSON.stringify({defaultDevice: 'pc-fixture', devices}, null, 2));

	const s = startServer('pc', {TV_DEBUG_CONFIG: cfgPath});
	await s.ready;

	console.log('\n--- devices ---');
	const list = await s.call('tv_devices');
	const pc = (list.devices || []).find((d) => d.id === 'pc-fixture');
	check('pc device is listed', !!pc, (list.devices || []).map((d) => d.id).join(','));
	check('pc reports the dev-server status', pc?.status === 'dev-server-up', pc?.status);
	check('pc capabilities are honest (no install, screenshot yes)',
		pc?.capabilities?.install === false && pc?.capabilities?.screenshot === true,
		JSON.stringify(pc?.capabilities));
	check('pc defaults to trusted input', pc?.capabilities?.inputMode === 'trusted', pc?.capabilities?.inputMode);
	check('the parity device is pinned to synthetic',
		(list.devices || []).find((d) => d.id === 'pc-parity')?.capabilities?.inputMode === 'synthetic');

	const refused = await s.call('tv_install', {device: 'pc-fixture', path: '/tmp/nope.wgt'});
	check('tv_install on pc is refused with a reason',
		!!refused.__error && /does not apply/.test(refused.__error), String(refused.__error).slice(0, 100));

	const dead = await s.call('tv_launch', {device: 'pc-dead'});
	check('a missing dev server is an actionable error',
		!!dead.__error && /not answering/.test(dead.__error) && /never starts or stops/.test(dead.__error),
		String(dead.__error).slice(0, 140));

	console.log('\n--- launch our own Chrome ---');
	const launched = await s.call('tv_launch', {device: 'pc-fixture'});
	check('tv_launch starts Chrome and attaches', !!launched.attached?.wsUrl, launched.__error);
	check('the page is the configured URL', String(launched.attached?.href || '').startsWith(fixtureUrl),
		launched.attached?.href);
	check('Chrome runs on an isolated throwaway profile', (await chromeCount()) > 0);

	console.log('\n--- navigation, unchanged from the TV path ---');
	const booted = await s.call('tv_wait_for', {device: 'pc-fixture', selector: '.demo-tile', timeoutMs: 20000, stableMs: 300});
	check('tv_wait_for works in the browser', booted.ok, `${booted.elapsedMs}ms`);

	const st = await s.call('tv_state', {device: 'pc-fixture'});
	check('tv_state returns structured focus', !!st.focus?.path && st.counts?.tiles > 0, JSON.stringify(st.counts));

	const pressed = await s.call('tv_press', {device: 'pc-fixture', key: 'RIGHT'});
	check('trusted key events reach the app', pressed.focusChanged === true,
		`${String(pressed.focusedBefore).slice(0, 40)} -> ${String(pressed.focusedAfter).slice(0, 40)}`);
	check('press records its input mode', pressed.inputMode === 'trusted', pressed.inputMode);

	const goto = await s.call('tv_goto', {device: 'pc-fixture', direction: 'RIGHT', text: 'космос', maxSteps: 8});
	check('tv_goto reaches a tile by text', goto.ok, goto.reason || `${goto.presses} presses`);

	const menu = await s.call('tv_menu', {device: 'pc-fixture', item: 'Settings'});
	check('tv_menu selects a section', menu.ok, menu.reason || JSON.stringify(menu.items));

	console.log('\n--- screenshots (the thing Tizen cannot do) ---');
	const shotPath = join(dir, 'shot.png');
	const shot = await s.call('tv_screenshot', {device: 'pc-fixture', path: shotPath});
	check('screenshot produces real pixels in the browser',
		shot.ok === true && existsSync(shotPath) && statSync(shotPath).size > 5000,
		shot.ok ? `${shot.bytes} bytes` : shot.note);

	console.log('\n--- CPU profiling ---');
	const orphanStop = await s.call('tv_profile', {device: 'pc-fixture', action: 'stop'});
	check('stop without start is an actionable error',
		!!orphanStop.__error && /no profiling in progress/.test(orphanStop.__error),
		String(orphanStop.__error).slice(0, 100));

	const profStart = await s.call('tv_profile', {device: 'pc-fixture', action: 'start'});
	check('tv_profile starts a recording', profStart.ok === true, profStart.__error);
	const doubleStart = await s.call('tv_profile', {device: 'pc-fixture', action: 'start'});
	check('a second start is refused instead of silently replacing the recording',
		!!doubleStart.__error && /already in progress/.test(doubleStart.__error),
		String(doubleStart.__error).slice(0, 100));

	// A named function burning a known amount of CPU: it has to show up by name in the summary.
	await s.call('tv_evaluate', {
		device: 'pc-fixture',
		expression: '(function(){ function tvDebugBusyLoop(){var t=Date.now(),x=0;while(Date.now()-t<700){x+=Math.sqrt(x+1);}return x;} return Math.round(tvDebugBusyLoop()); })()'
	});
	const profPath = join(dir, 'busy.cpuprofile');
	const prof = await s.call('tv_profile', {device: 'pc-fixture', action: 'stop', path: profPath, topN: 15});
	check('tv_profile stops and writes a .cpuprofile', prof.ok === true && existsSync(profPath) && statSync(profPath).size > 1000,
		prof.ok ? `${prof.bytes} bytes, ${prof.durationMs}ms` : prof.__error);
	check('the profile is the modern format in a current Chrome', prof.format === 'modern', prof.format);
	check('the busy function is in the hot list by name',
		(prof.summary?.topFunctions || []).some((f) => f.name === 'tvDebugBusyLoop'),
		(prof.summary?.topFunctions || []).slice(0, 5).map((f) => `${f.name}=${f.selfMs}ms`).join(' '));
	check('the summary carries real sample data', prof.summary?.sampleCount > 0 && prof.summary?.totalMs > 100,
		`${prof.summary?.sampleCount} samples / ${prof.summary?.totalMs}ms`);
	check('the raw profile is NOT inlined into the response', prof.summary?.nodes === undefined && prof.nodes === undefined);
	const missingMap = await s.call('tv_profile', {device: 'pc-fixture', action: 'stop'});
	check('the recording is released after a stop',
		!!missingMap.__error && /no profiling in progress/.test(missingMap.__error),
		String(missingMap.__error).slice(0, 100));

	// The recording lives in the page's V8. Losing that V8 must be reported as a lost profile,
	// not as an empty one and not as "you never started".
	await s.call('tv_profile', {device: 'pc-fixture', action: 'start'});
	await s.call('tv_launch', {device: 'pc-fixture', relaunch: true});
	const lost = await s.call('tv_profile', {device: 'pc-fixture', action: 'stop'});
	check('a relaunch mid-recording is reported as a discarded profile',
		!!lost.__error && /profile discarded/.test(lost.__error), String(lost.__error).slice(0, 140));
	await s.call('tv_wait_for', {device: 'pc-fixture', selector: '.demo-tile', timeoutMs: 20000, stableMs: 300});
	const afterLost = await s.call('tv_profile', {device: 'pc-fixture', action: 'start'});
	check('profiling can be started again after a lost recording', afterLost.ok === true, afterLost.__error);
	await s.call('tv_profile', {device: 'pc-fixture', action: 'stop', path: join(dir, 'after-lost.cpuprofile')});

	console.log('\n--- metrics (Performance.getMetrics) ---');
	const snap = await s.call('tv_profile', {device: 'pc-fixture', action: 'metrics'});
	check('action:metrics returns a reading with the usual counters',
		typeof snap.metrics?.JSHeapUsedSize === 'number' && typeof snap.metrics?.Nodes === 'number',
		snap.__error || Object.keys(snap.metrics || {}).slice(0, 8).join(','));

	// A recording bracketing a known amount of DOM growth: the diff has to see it. 1 div +
	// 500 spans + 500 text nodes, so anything above 500 proves the two readings are real and
	// in the right order.
	await s.call('tv_profile', {device: 'pc-fixture', action: 'start'});
	await s.call('tv_evaluate', {
		device: 'pc-fixture',
		expression: '(function(){var d=document.createElement("div");d.id="tv-debug-leak";' +
			'for(var i=0;i<500;i++){var sp=document.createElement("span");sp.appendChild(document.createTextNode("x"));d.appendChild(sp);}' +
			'document.body.appendChild(d);return document.getElementsByTagName("*").length;})()'
	});
	const withMetrics = await s.call('tv_profile', {
		device: 'pc-fixture', action: 'stop', path: join(dir, 'metrics.cpuprofile')
	});
	const values = withMetrics.metrics?.values || {};
	check('stop reports before/after/diff per metric',
		typeof values.Nodes?.before === 'number' && typeof values.Nodes?.after === 'number' && typeof values.Nodes?.diff === 'number',
		withMetrics.__error || JSON.stringify(values.Nodes));
	check('DOM growth inside the recording shows up in the Nodes diff',
		values.Nodes?.diff >= 500, `diff=${values.Nodes?.diff}`);
	check('the window length comes from the engine clock, not the host',
		typeof withMetrics.metrics?.windowSec === 'number' && withMetrics.metrics.windowSec > 0,
		String(withMetrics.metrics?.windowSec));
	check('the whole engine metric list is reported, not a whitelist',
		Object.keys(values).length >= 10, Object.keys(values).length + ' metrics');
	check('the CPU profile is unaffected by the metrics riding along',
		withMetrics.ok === true && withMetrics.summary?.sampleCount > 0,
		`${withMetrics.summary?.sampleCount} samples`);

	const gc = await s.call('tv_profile', {device: 'pc-fixture', action: 'metrics', collectGarbage: true});
	check('collectGarbage:true still returns a reading',
		typeof gc.metrics?.JSHeapUsedSize === 'number', gc.__error || JSON.stringify(gc.warnings));

	const seqMetrics = await s.call('tv_sequence', {
		device: 'pc-fixture',
		steps: [{metrics: true}, {press: 'RIGHT'}, {metrics: {collectGarbage: true}}]
	});
	check('metrics works as a sequence step, at both ends of a scenario',
		seqMetrics.ok && typeof seqMetrics.steps?.[0]?.result?.metrics?.Nodes === 'number' &&
		typeof seqMetrics.steps?.[2]?.result?.metrics?.Nodes === 'number',
		JSON.stringify((seqMetrics.steps || []).map((x) => `${x.step}=${x.ok}`)));

	console.log('\n--- heap snapshots (tv_heap) ---');
	const heapBefore = join(dir, 'before.heapsnapshot');
	const h1 = await s.call('tv_heap', {device: 'pc-fixture', action: 'snapshot', path: heapBefore, topN: 25});
	check('tv_heap writes a .heapsnapshot file', h1.ok === true && existsSync(heapBefore) && statSync(heapBefore).size > 100000,
		h1.ok ? `${h1.bytes} bytes in ${h1.chunks} chunks, ${h1.durationMs}ms` : h1.__error);
	check('the file on disk is the size the tool reported', h1.ok && statSync(heapBefore).size === h1.bytes,
		`${statSync(heapBefore).size} vs ${h1.bytes}`);
	check('a real snapshot parses into a constructor summary',
		h1.summary?.ok === true && h1.summary.totalNodes > 1000 && h1.summary.topConstructors?.length === 25,
		JSON.stringify({nodes: h1.summary?.totalNodes, top: h1.summary?.topConstructors?.length}));
	check('the summary names DOM constructors of the page',
		(h1.summary?.topConstructors || []).some((c) => /HTML|Window|Document|\(string\)/.test(c.name)),
		(h1.summary?.topConstructors || []).slice(0, 5).map((c) => c.name).join(','));
	check('the raw snapshot is NOT inlined into the response',
		h1.nodes === undefined && h1.summary?.nodes === undefined && JSON.stringify(h1).length < 8000,
		`${JSON.stringify(h1).length} chars`);

	// A leak with a name: 2000 objects of one constructor plus a detached DOM subtree, both
	// held from a global so the snapshot's own full GC cannot collect them.
	await s.call('tv_evaluate', {
		device: 'pc-fixture',
		expression: '(function(){function TvDebugLeakItem(i){this.i=i;this.pad="x";}' +
			'window.__tvDebugLeak=[];for(var i=0;i<2000;i++){window.__tvDebugLeak.push(new TvDebugLeakItem(i));}' +
			'var d=document.createElement("div");' +
			'for(var j=0;j<300;j++){d.appendChild(document.createElement("span"));}' +
			'document.body.appendChild(d);document.body.removeChild(d);window.__tvDebugDetached=d;' +
			'return window.__tvDebugLeak.length;})()'
	});
	const heapAfter = join(dir, 'after.heapsnapshot');
	const h2 = await s.call('tv_heap', {device: 'pc-fixture', action: 'snapshot', path: heapAfter});
	check('a second snapshot succeeds on the same connection', h2.ok === true, h2.__error);
	check('detached DOM nodes retained from JS are counted', h2.summary?.detachedCount > h1.summary?.detachedCount,
		`${h1.summary?.detachedCount} -> ${h2.summary?.detachedCount}`);

	const heapDiff = await s.call('tv_heap', {action: 'diff', before: heapBefore, after: heapAfter, topN: 30});
	check('diff sees the leaked constructor by name',
		(heapDiff.topGrowth || []).some((r) => r.name === 'TvDebugLeakItem' && r.deltaCount >= 2000),
		JSON.stringify((heapDiff.topGrowth || []).slice(0, 4)));
	check('diff sees the detached nodes grow',
		heapDiff.delta?.detachedCount >= 300, String(heapDiff.delta?.detachedCount));
	check('diff reports both totals and the delta',
		heapDiff.before?.totalNodes > 0 && heapDiff.after?.totalNodes > heapDiff.before.totalNodes &&
		heapDiff.delta?.totalSize > 0,
		JSON.stringify(heapDiff.delta));

	// A snapshot is a full GC and a long V8 pause: taking one inside a recording would time
	// the pause instead of the app.
	await s.call('tv_profile', {device: 'pc-fixture', action: 'start'});
	const heapDuringProfile = await s.call('tv_heap', {device: 'pc-fixture', action: 'snapshot', path: join(dir, 'never.heapsnapshot')});
	check('a snapshot is refused while a CPU recording is running',
		!!heapDuringProfile.__error && /stop the CPU profile first/.test(heapDuringProfile.__error),
		String(heapDuringProfile.__error).slice(0, 120));
	check('the refused snapshot left no file behind', !existsSync(join(dir, 'never.heapsnapshot')));
	await s.call('tv_profile', {device: 'pc-fixture', action: 'stop', path: join(dir, 'after-heap.cpuprofile')});

	console.log('\n--- sequence: the long-press case, in the browser ---');
	const seq = await s.call('tv_sequence', {
		device: 'pc-fixture',
		steps: [
			{goto: {direction: 'RIGHT', selector: '.demo-tile', maxSteps: 4}},
			{longpress: 'ENTER', durationMs: 1200},
			{expect: {selector: '.demo-popup'}, timeoutMs: 5000},
			{press: 'BACK'},
			{expect: {selectorGone: '.demo-popup'}, timeoutMs: 5000}
		]
	});
	check('tv_sequence runs the long-press case in the browser', seq.ok,
		JSON.stringify((seq.steps || []).map((x) => `${x.step}=${x.ok}`)));
	for (const step of seq.steps || []) {
		console.log(`        ${step.ok ? 'ok ' : 'FAIL'} ${step.elapsedMs}ms  ${step.step}`);
	}

	// tv_sequence holds the operation lock, so a separate tv_profile call cannot run inside a
	// scenario — profiling a scenario has to be expressible as steps.
	const seqProfPath = join(dir, 'seq.cpuprofile');
	const profSeq = await s.call('tv_sequence', {
		device: 'pc-fixture',
		steps: [
			{profileStart: {samplingIntervalUs: 500}},
			{press: 'RIGHT', repeat: 3, intervalMs: 100},
			{profileStop: {path: seqProfPath, topN: 10}}
		]
	});
	check('a sequence can profile the scenario it runs', profSeq.ok && existsSync(seqProfPath),
		JSON.stringify((profSeq.steps || []).map((x) => `${x.step}=${x.ok}`)));
	check('the profileStop step carries the path and the summary',
		profSeq.steps?.[2]?.result?.path === seqProfPath && !!profSeq.steps?.[2]?.result?.summary,
		JSON.stringify(profSeq.steps?.[2]?.result?.summary?.totalMs));

	console.log('\n--- parity run: TV-identical synthetic input ---');
	await s.call('tv_launch', {device: 'pc-parity'});
	await s.call('tv_wait_for', {device: 'pc-parity', selector: '.demo-tile', timeoutMs: 20000, stableMs: 300});
	const parityPress = await s.call('tv_press', {device: 'pc-parity', key: 'RIGHT'});
	check('synthetic input drives the browser too', parityPress.focusChanged === true,
		`${String(parityPress.focusedBefore).slice(0, 40)} -> ${String(parityPress.focusedAfter).slice(0, 40)}`);
	check('parity press is labelled synthetic', parityPress.inputMode === 'synthetic', parityPress.inputMode);
	const paritySeq = await s.call('tv_sequence', {
		device: 'pc-parity',
		steps: [
			{longpress: 'ENTER', durationMs: 1200},
			{expect: {selector: '.demo-popup'}, timeoutMs: 5000}
		]
	});
	check('the long-press case passes in parity mode too', paritySeq.ok,
		JSON.stringify((paritySeq.steps || []).map((x) => `${x.step}=${x.ok}`)));

	if (devUp) {
		console.log(`\n--- bonus: your dev server (${devApp} at ${devUrl}) ---`);
		const real = await s.call('tv_launch', {device: 'pc-app'});
		check('the app loads in our Chrome', !!real.attached?.wsUrl, real.__error);
		const cat = await s.call('tv_wait_for', {device: 'pc-app', selector: devTile, timeoutMs: 60000, stableMs: 700});
		check('the app catalog renders in the browser', cat.ok, `${cat.elapsedMs}ms`);
	} else {
		console.log('\n  (skipped the product dev-server run — set TV_DEV_URL and TV_DEV_APP to enable it)');
	}

	console.log('\n--- cleanup ---');
	s.stop();
	// Chrome takes a moment to reap its helper processes; poll instead of guessing a sleep.
	let left = await chromeCount();
	for (let i = 0; i < 20 && left > 0; i++) {
		await sleep(500);
		left = await chromeCount();
	}
	check('our Chrome instances are gone', left === 0, `${left} left`);
	check('the static server is untouched', await urlUp(fixtureUrl));

	stopFixture();
	process.exit(check.summary() ? 1 : 0);
}

main().catch((e) => {
	console.error('phase2-check crashed:', e);
	process.exit(2);
});
