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
//   8. the .heapsnapshot parser: constructor tally, detached nodes (named and flagged), the
//      diff of two snapshots, and honest failure on a file that is not a snapshot
//   9. the network log: the record lifecycle fed straight into a socket-less CdpSession
//      (response, redirect hops, failure, extra-info headers, ring-buffer eviction), the
//      filters, the curl builder (secrets redacted, quotes escaped) and the HAR builder
//  10. the expectRequest poller: early success, and the two shapes that must wait out the
//      whole window (`absent`, `count.max`)
//
// Run: node test/phase0-offline.mjs
import {spawn} from 'node:child_process';
import {writeFileSync, readFileSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {SourceMapGenerator} from 'source-map-js';

import {summarizeProfile, applySourceMap} from '../src/profile.js';
import {summarizeHeapSnapshot, diffHeapSummaries} from '../src/heap.js';
import {metricsToMap, metricsDiff, windowSecondsOf} from '../src/metrics.js';
import {CdpSession} from '../src/cdp.js';
import {selectRequests, toListEntry, buildCurl, buildHar, capBody, compileUrlPattern} from '../src/network.js';
import {pollRequests} from '../src/wait.js';

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

/** 8: the heap-snapshot parser. Pure — two small fixtures, no device. */
function heapChecks() {
	console.log('\n--- heap snapshot parser ---');
	const beforePath = join(__dirname, 'fixture', 'heap', 'before.heapsnapshot');
	const afterPath = join(__dirname, 'fixture', 'heap', 'after.heapsnapshot');

	const before = summarizeHeapSnapshot(beforePath);
	const after = summarizeHeapSnapshot(afterPath, {topN: 3});

	check('totals come from the nodes array', before.ok && before.totalNodes === 7 && before.totalSize === 556,
		JSON.stringify({nodes: before.totalNodes, size: before.totalSize}));
	check('constructors are tallied by count and shallow size',
		before.topConstructors.find((c) => c.name === 'MovieTile')?.count === 2 &&
		before.topConstructors.find((c) => c.name === 'MovieTile')?.shallowBytes === 200,
		JSON.stringify(before.topConstructors));
	check('type buckets replace the missing constructor name ((string), (array))',
		before.topConstructors.some((c) => c.name === '(string)') && before.topConstructors.some((c) => c.name === '(array)'),
		before.topConstructors.map((c) => c.name).join(','));
	check('closures are grouped by function name',
		before.topConstructors.some((c) => c.name === 'onScroll()'),
		before.topConstructors.map((c) => c.name).join(','));
	check('a bracket inside a string does not truncate the strings array',
		before.topConstructors.find((c) => c.name === '(string)')?.count === 1,
		JSON.stringify(before.topConstructors.find((c) => c.name === '(string)')));
	check('detached nodes are counted by name prefix', before.detachedCount === 1 && before.detachedSize === 60,
		JSON.stringify({count: before.detachedCount, size: before.detachedSize}));

	check('a node flagged detachedness:2 counts as detached even when its name is not prefixed',
		after.detachedCount === 5 && after.detachedSize === 300,
		JSON.stringify({count: after.detachedCount, size: after.detachedSize}));
	check('a flagged node lands in the same bucket as the named ones',
		after.topConstructors.find((c) => c.name === 'Detached HTMLDivElement')?.count === 5,
		JSON.stringify(after.topConstructors));
	check('topN caps the constructor list', after.topConstructors.length === 3, String(after.topConstructors.length));
	check('constructors are ordered by shallow size', after.topConstructors[0]?.name === 'MovieTile',
		after.topConstructors.map((c) => c.name).join(','));
	check('the full constructor count is reported, not just the top-N', after.constructors === 5,
		String(after.constructors));

	const diff = diffHeapSummaries(beforePath, afterPath);
	check('diff reports the totals of both sides',
		diff.before.totalNodes === 7 && diff.after.totalNodes === 15,
		JSON.stringify({before: diff.before.totalNodes, after: diff.after.totalNodes}));
	check('diff reports the deltas of the totals',
		diff.delta.totalNodes === 8 && diff.delta.totalSize === 420 && diff.delta.detachedCount === 4,
		JSON.stringify(diff.delta));
	const grown = diff.topGrowth[0];
	check('the biggest grower comes first with before/after counts',
		grown?.name === 'MovieTile' && grown?.deltaCount === 3 && grown?.deltaBytes === 300 &&
		grown?.countBefore === 2 && grown?.countAfter === 5,
		JSON.stringify(grown));
	check('detached growth is visible as its own constructor row',
		diff.topGrowth.some((r) => r.name === 'Detached HTMLDivElement' && r.deltaCount === 4),
		JSON.stringify(diff.topGrowth.map((r) => r.name)));
	check('a constructor that disappeared shows up as a shrink',
		diff.topShrink[0]?.name === 'Grid' && diff.topShrink[0]?.deltaBytes === -200 && diff.topShrink[0]?.countAfter === 0,
		JSON.stringify(diff.topShrink));
	check('unchanged constructors are left out of the diff', diff.constructorsChanged === 4 &&
		!diff.topGrowth.concat(diff.topShrink).some((r) => r.name === '(array)'),
		String(diff.constructorsChanged));

	// --- broken input ---
	const dir = mkdtempSync(join(tmpdir(), 'tv-debug-heap-'));
	const garbage = join(dir, 'garbage.heapsnapshot');
	writeFileSync(garbage, 'this is not JSON at all {');
	let broke = null;
	try {
		summarizeHeapSnapshot(garbage);
	} catch (e) {
		broke = e.message;
	}
	check('a file that is not JSON is rejected with a clear message',
		!!broke && /not a readable \.heapsnapshot/.test(broke), broke);

	const wrongJson = join(dir, 'wrong.heapsnapshot');
	writeFileSync(wrongJson, JSON.stringify({hello: 'world'}));
	broke = null;
	try {
		summarizeHeapSnapshot(wrongJson);
	} catch (e) {
		broke = e.message;
	}
	check('valid JSON that is not a snapshot is rejected too',
		!!broke && /not a \.heapsnapshot/.test(broke), broke);

	// An engine that predates the `detachedness` column: same file without it.
	const legacyPath = join(dir, 'legacy.heapsnapshot');
	const raw = JSON.parse(readFileSync(afterPath, 'utf8'));
	const fields = raw.snapshot.meta.node_fields;
	const detachedAt = fields.indexOf('detachedness');
	raw.snapshot.meta.node_fields = fields.filter((f) => f !== 'detachedness');
	raw.snapshot.meta.node_types = raw.snapshot.meta.node_types.filter((_, i) => i !== detachedAt);
	raw.nodes = raw.nodes.filter((_, i) => i % fields.length !== detachedAt);
	writeFileSync(legacyPath, JSON.stringify(raw));
	const legacy = summarizeHeapSnapshot(legacyPath);
	check('a snapshot without the detachedness column still parses (field order is read, not assumed)',
		legacy.ok && legacy.totalNodes === 15 && legacy.totalSize === 976,
		JSON.stringify({nodes: legacy.totalNodes, size: legacy.totalSize}));
	check('without the column only the named detached nodes are counted', legacy.detachedCount === 4,
		String(legacy.detachedCount));
}

/** 9: the network log. The CDP session is fed events by hand — no socket, no TV. */
function networkChecks() {
	console.log('\n--- network log: record lifecycle ---');
	const cdp = new CdpSession('ws://127.0.0.1:1');
	const feed = (method, params) => cdp._onEvent(method, params);

	feed('Network.requestWillBeSent', {
		requestId: '1', type: 'XHR',
		request: {
			url: 'https://tv.local/stat?src=app', method: 'POST',
			headers: {'Content-Type': 'application/json'},
			postData: '{"event":"nav","event_id":"main"}'
		}
	});
	feed('Network.responseReceived', {
		requestId: '1',
		response: {
			status: 200, statusText: 'OK', mimeType: 'application/json', protocol: 'http/1.1',
			headers: {'Content-Type': 'application/json'},
			timing: {requestTime: 1, sendStart: 1, sendEnd: 3, receiveHeadersEnd: 23}
		}
	});
	feed('Network.loadingFinished', {requestId: '1', encodedDataLength: 512});

	const first = cdp.network[0];
	check('requestWillBeSent creates a record with method, url and body',
		first?.method === 'POST' && first?.url === 'https://tv.local/stat?src=app' &&
		first?.postData === '{"event":"nav","event_id":"main"}',
		JSON.stringify({m: first?.method, u: first?.url}));
	check('responseReceived fills in status and mime type',
		first?.status === 200 && first?.mimeType === 'application/json', JSON.stringify(first?.status));
	check('loadingFinished finalises the record with its transfer size',
		first?.finished === true && first?.encodedDataLength === 512,
		JSON.stringify({finished: first?.finished, bytes: first?.encodedDataLength}));
	check('receivedAt is host time, not the engine clock', typeof first?.receivedAt === 'number' && first.receivedAt > 1e12,
		String(first?.receivedAt));

	// A redirect reuses the requestId: each hop has to survive as its own record.
	feed('Network.requestWillBeSent', {requestId: '2', request: {url: 'https://tv.local/a', method: 'GET'}});
	feed('Network.requestWillBeSent', {
		requestId: '2', request: {url: 'https://tv.local/b', method: 'GET'},
		redirectResponse: {status: 302, headers: {Location: 'https://tv.local/b'}}
	});
	feed('Network.responseReceived', {requestId: '2', response: {status: 200, mimeType: 'text/html'}});
	feed('Network.loadingFinished', {requestId: '2', encodedDataLength: 40});
	const hops = cdp.network.filter((r) => r.requestId === '2');
	check('a redirect is two records, not one overwritten', hops.length === 2, String(hops.length));
	check('the first hop keeps the 302 and where it went',
		hops[0]?.status === 302 && hops[0]?.redirectedTo === 'https://tv.local/b' && hops[0]?.finished === true,
		JSON.stringify({status: hops[0]?.status, to: hops[0]?.redirectedTo}));
	check('the second hop remembers where it came from and carries the real answer',
		hops[1]?.redirectFrom === 'https://tv.local/a' && hops[1]?.status === 200,
		JSON.stringify({from: hops[1]?.redirectFrom, status: hops[1]?.status}));

	feed('Network.requestWillBeSent', {requestId: '3', request: {url: 'http://127.0.0.1:1/nowhere', method: 'GET'}});
	feed('Network.loadingFailed', {requestId: '3', errorText: 'net::ERR_CONNECTION_REFUSED'});
	const failedRec = cdp.network.find((r) => r.requestId === '3');
	check('a failed request is finished and carries errorText',
		failedRec?.failed === true && failedRec?.finished === true && /ERR_CONNECTION_REFUSED/.test(failedRec?.errorText),
		JSON.stringify(failedRec?.errorText));
	check('tv_console networkFailures still gets its entry (the old contract is untouched)',
		cdp.networkFailures.length === 1 && cdp.networkFailures[0].url === 'http://127.0.0.1:1/nowhere',
		JSON.stringify(cdp.networkFailures[0]));

	// ExtraInfo is allowed to arrive before the request it belongs to.
	feed('Network.requestWillBeSentExtraInfo', {requestId: '4', headers: {cookie: 'sid=xyz', 'user-agent': 'TV'}});
	feed('Network.requestWillBeSent', {
		requestId: '4', request: {url: 'https://tv.local/late', method: 'GET', headers: {Accept: '*/*'}}
	});
	const late = cdp.network.find((r) => r.requestId === '4');
	check('extra-info headers that arrived early are applied to the record',
		late?.headersFromWire === true && late?.requestHeaders?.cookie === 'sid=xyz' && late?.requestHeaders?.Accept === '*/*',
		JSON.stringify(late?.requestHeaders));

	const evicting = new CdpSession('ws://127.0.0.1:1');
	for (let i = 0; i < 1100; i++) {
		evicting._onEvent('Network.requestWillBeSent', {requestId: String(i), request: {url: `https://tv.local/${i}`, method: 'GET'}});
	}
	check('the network buffer holds 1000 requests, not the console limit of 500',
		evicting.network.length === 1000, String(evicting.network.length));
	check('what fell out of the buffer is counted, so an assertion cannot fail silently',
		evicting.dropped.network === 100, String(evicting.dropped.network));

	const big = new CdpSession('ws://127.0.0.1:1');
	big._onEvent('Network.requestWillBeSent', {
		requestId: 'big', request: {url: 'https://tv.local/upload', method: 'POST', postData: 'x'.repeat(70000)}
	});
	const bigRec = big.network[0];
	check('a body over 64KB is stored truncated and flagged',
		bigRec?.postDataTruncated === true && bigRec.postData.length === 65536,
		JSON.stringify({len: bigRec?.postData?.length, flag: bigRec?.postDataTruncated}));

	console.log('\n--- network log: filters ---');
	const now = 1700000000000;
	const recs = [
		{seq: 1, requestId: 'a', receivedAt: now, method: 'GET', url: 'https://tv.local/api/catalog?id=1', status: 200, postData: null, finished: true},
		{seq: 2, requestId: 'b', receivedAt: now + 10, method: 'POST', url: 'https://stat.tv.local/track', status: 200, postData: '{"event_id":"home"}', finished: true},
		{seq: 3, requestId: 'c', receivedAt: now + 20, method: 'POST', url: 'https://stat.tv.local/track', status: 500, postData: '{"no_code":1}', finished: true},
		{seq: 4, requestId: 'd', receivedAt: now + 30, method: 'GET', url: 'http://dead.local/x', status: null, failed: true, errorText: 'ERR', finished: true}
	];
	const n = (f) => selectRequests(recs, f).length;
	check('urlPattern is a substring by default', n({urlPattern: 'track'}) === 2, String(n({urlPattern: 'track'})));
	check('urlPattern is case-insensitive', n({urlPattern: 'TRACK'}) === 2, String(n({urlPattern: 'TRACK'})));
	check('/…/ is a regex', n({urlPattern: '/^https:\\/\\/stat\\./'}) === 2, String(n({urlPattern: '/^https:\\/\\/stat\\./'})));
	check('a broken regex is rejected with a clear message', (() => {
		try {
			compileUrlPattern('/[unclosed/');
			return false;
		} catch (e) {
			return /not a valid regex/.test(e.message);
		}
	})());
	check('method filters', n({method: 'post'}) === 2, String(n({method: 'post'})));
	check('an exact status filters', n({status: 200}) === 2, String(n({status: 200})));
	check('a status range filters', n({status: {min: 200, max: 299}}) === 2, String(n({status: {min: 200, max: 299}})));
	check('statusMax is the same range, flat', n({statusMax: 399}) === 2, String(n({statusMax: 399})));
	check('status:"failed" picks the request that never answered', n({status: 'failed'}) === 1, String(n({status: 'failed'})));
	check('a request with no status yet cannot satisfy a status filter',
		n({status: {min: 0, max: 1000}}) === 3, String(n({status: {min: 0, max: 1000}})));
	check('since cuts the window', n({since: now + 20}) === 2, String(n({since: now + 20})));
	check('bodyContains matches the POST body', n({bodyContains: 'event_id'}) === 1, String(n({bodyContains: 'event_id'})));
	check('bodyContains is case-sensitive (JSON keys are)', n({bodyContains: 'EVENT_ID'}) === 0,
		String(n({bodyContains: 'EVENT_ID'})));
	check('the track assertion of the motivating regression matches exactly one request',
		n({urlPattern: 'track', method: 'POST', bodyContains: 'event_id', statusMax: 399}) === 1,
		String(n({urlPattern: 'track', method: 'POST', bodyContains: 'event_id', statusMax: 399})));
	check('an unusable status value is rejected instead of matching nothing', (() => {
		try {
			selectRequests(recs, {status: 'green'});
			return false;
		} catch (e) {
			return /status must be/.test(e.message);
		}
	})());

	const long = toListEntry({
		seq: 9, requestId: 'z', receivedAt: now, method: 'POST', url: 'https://tv.local/?q=' + 'u'.repeat(900),
		status: 200, postData: 'b'.repeat(4000), finished: true
	});
	check('a list entry cuts the url at 500 and says so', long.url.length === 500 && long.urlTruncated === true,
		String(long.url.length));
	check('a list entry cuts the body at 1000 and says so',
		long.postData.length === 1000 && long.postDataTruncated === true, String(long.postData.length));
	check('an unfinished request is marked in-flight',
		toListEntry({seq: 1, requestId: 'x', receivedAt: now, url: 'u', method: 'GET', finished: false}).inFlight === true);

	console.log('\n--- network log: curl ---');
	const curlRec = {
		requestId: 'x', seq: 1, receivedAt: now, method: 'POST', url: 'https://tv.local/stat',
		requestHeaders: {
			'Content-Type': 'application/json', Cookie: 'sid=abc', 'X-Auth-Token': 'secret',
			':authority': 'tv.local', 'Content-Length': '12', 'X-Fixture': 'yes'
		},
		postData: '{"q":"it\'s"}', postDataTruncated: false, headersFromWire: false
	};
	const curl = buildCurl(curlRec);
	check('the command is a POST to the recorded url',
		curl.command.startsWith("curl -X POST 'https://tv.local/stat'"), curl.command.slice(0, 60));
	check('Cookie and token headers are redacted by default',
		/Cookie: REDACTED/.test(curl.command) && /X-Auth-Token: REDACTED/.test(curl.command) &&
		!curl.command.includes('sid=abc'),
		curl.command.slice(0, 200));
	check('an ordinary header survives', /X-Fixture: yes/.test(curl.command));
	check('pseudo-headers and Content-Length are left out (curl derives them)',
		!curl.command.includes(':authority') && !/Content-Length/.test(curl.command));
	check('a quote inside the body is escaped for the shell',
		curl.command.includes(`--data-raw '{"q":"it'\\''s"}'`), curl.command.slice(-40));
	check('redaction is announced as a warning', curl.warnings.some((w) => /raw:true/.test(w)),
		JSON.stringify(curl.warnings));
	check('an engine without extra-info headers warns that cookies may be missing',
		curl.warnings.some((w) => /cookies may be missing/.test(w)), JSON.stringify(curl.warnings));
	const curlRaw = buildCurl(curlRec, {raw: true});
	check('raw:true keeps the real values', curlRaw.command.includes('sid=abc') && !curlRaw.command.includes('REDACTED'));
	const curlWire = buildCurl({...curlRec, headersFromWire: true, postDataTruncated: true});
	check('a truncated body warns that the command is incomplete',
		curlWire.warnings.some((w) => /body was truncated/.test(w)) &&
		!curlWire.warnings.some((w) => /cookies may be missing/.test(w)),
		JSON.stringify(curlWire.warnings));

	console.log('\n--- network log: HAR ---');
	const harRecs = [
		{
			seq: 2, requestId: 'b', receivedAt: now + 1000, finishedAt: now + 1100, method: 'POST',
			url: 'https://stat.tv.local/track?v=1', status: 200, statusText: 'OK', protocol: 'http/1.1',
			mimeType: 'application/json', requestHeaders: {'Content-Type': 'application/json'},
			responseHeaders: {'Content-Type': 'application/json'},
			postData: '{"event_id":"home"}', encodedDataLength: 120,
			timing: {requestTime: 1, sendStart: 1, sendEnd: 3, receiveHeadersEnd: 23}, finished: true
		},
		{
			seq: 1, requestId: 'a', receivedAt: now, method: 'GET', url: 'https://tv.local/api/catalog?id=1',
			status: 200, statusText: 'OK', mimeType: 'text/html', requestHeaders: {}, responseHeaders: {},
			postData: null, encodedDataLength: 900, timing: null, finished: true
		}
	];
	const har = buildHar(harRecs, {bodies: new Map([[2, {body: '{"ok":1}', base64Encoded: false}]]), version: 't'});
	check('the file is HAR 1.2 with this tool as creator',
		har.log.version === '1.2' && har.log.creator.name === 'tv-debug-mcp', JSON.stringify(har.log.creator));
	check('entries are ordered by time, not by buffer order',
		har.log.entries[0].request.url.includes('/api/catalog'), har.log.entries[0].request.url);
	const post = har.log.entries[1];
	check('the POST body is in the entry', post.request.postData?.text === '{"event_id":"home"}',
		JSON.stringify(post.request.postData));
	check('the query string is parsed out',
		post.request.queryString?.[0]?.name === 'v' && post.request.queryString[0].value === '1',
		JSON.stringify(post.request.queryString));
	check('a body that was read is in content.text with its size',
		post.response.content.text === '{"ok":1}' && post.response.content.size === 8,
		JSON.stringify(post.response.content));
	check('engine timings become HAR timings (wait = sendEnd -> headers)',
		post.timings.wait === 20 && post.timings.send === 2, JSON.stringify(post.timings));
	check('what the engine did not report is -1, per the HAR spec, not an invented number',
		har.log.entries[0].timings.wait === -1 && har.log.entries[0].timings.dns === -1 && har.log.entries[0].time === -1,
		JSON.stringify(har.log.entries[0].timings));
	check('an entry without a body says why instead of looking empty',
		/body evicted/.test(har.log.entries[0].comment || ''), har.log.entries[0].comment);
	check('withBodies:false says the bodies were never asked for, not that they were lost',
		/not requested/.test(buildHar(harRecs, {withBodies: false}).log.entries[0].comment || ''),
		buildHar(harRecs, {withBodies: false}).log.entries[0].comment);
	check('the HAR is valid JSON of a plain object', JSON.parse(JSON.stringify(har)).log.entries.length === 2);

	const capped = capBody('y'.repeat(300000), false);
	check('a body over the guard size is cut and flagged',
		capped.truncated === true && capped.body.length === 256 * 1024 && capped.bytes === 300000,
		JSON.stringify({len: capped.body.length, bytes: capped.bytes}));
}

/** 10: the expectRequest poller — the part where "not yet" and "never" differ. */
async function requestWaitChecks() {
	console.log('\n--- expectRequest poller ---');
	const io = (count) => ({networkMatches: () => ({count, samples: []})});

	const hit = await pollRequests(io(1), {urlPattern: 'track'}, {timeoutMs: 2000, intervalMs: 50});
	check('a match returns as soon as it is there', hit.ok === true && hit.polls === 1 && hit.elapsedMs < 500,
		JSON.stringify({polls: hit.polls, ms: hit.elapsedMs}));

	const missed = await pollRequests(io(0), {urlPattern: 'track'}, {timeoutMs: 300, intervalMs: 50});
	check('no match times out with a countable reason',
		missed.ok === false && missed.timedOut === true && /at least 1/.test(missed.reason), JSON.stringify(missed.reason));

	const absentOk = await pollRequests(io(0), {urlPattern: 'ads', absent: true}, {timeoutMs: 300, intervalMs: 50});
	check('absent:true succeeds only after the whole window',
		absentOk.ok === true && absentOk.elapsedMs >= 300, `${absentOk.elapsedMs}ms`);

	const absentFail = await pollRequests(io(2), {urlPattern: 'ads', absent: true}, {timeoutMs: 300, intervalMs: 50});
	check('absent:true fails when something matched',
		absentFail.ok === false && /expected no matching request, got 2/.test(absentFail.reason), absentFail.reason);

	const dup = await pollRequests(io(2), {urlPattern: 'stat.gif', count: {max: 1}}, {timeoutMs: 300, intervalMs: 50});
	check('count.max catches a duplicate and waits out the window to do it',
		dup.ok === false && dup.elapsedMs >= 300 && /at most 1/.test(dup.reason), `${dup.elapsedMs}ms ${dup.reason}`);

	const within = await pollRequests(io(1), {urlPattern: 'stat.gif', count: {max: 1}}, {timeoutMs: 300, intervalMs: 50});
	check('a single event inside count.max passes', within.ok === true && within.matched === 1, JSON.stringify(within.matched));
}

async function main() {
	profileChecks();
	metricsChecks();
	heapChecks();
	networkChecks();
	await requestWaitChecks();

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

	const badNetwork = await s.call('tv_network', {action: 'dump'});
	check('tv_network rejects an unknown action and names the real ones',
		!!badNetwork.__error && /"list", "body", "curl", "har" or "mark"/.test(badNetwork.__error), badNetwork.__error);
	const netNoLaunch = await s.call('tv_network', {});
	check('tv_network before a launch says so instead of returning an empty log',
		!!netNoLaunch.__error && /not launched/.test(netNoLaunch.__error), netNoLaunch.__error);
	check('server survived a network call without a device', s.alive());

	const badHeap = await s.call('tv_heap', {action: 'compare'});
	check('tv_heap rejects an unknown action and names the real ones',
		!!badHeap.__error && /"snapshot" or "diff"/.test(badHeap.__error), badHeap.__error);
	const heapNoPaths = await s.call('tv_heap', {action: 'diff', before: join(__dirname, 'fixture', 'heap', 'before.heapsnapshot')});
	check('tv_heap diff without both paths fails the call',
		!!heapNoPaths.__error && /`before` and `after`/.test(heapNoPaths.__error), heapNoPaths.__error);
	// The whole point of taking `device` off diff: it must work with every TV switched off.
	const heapDiff = await s.call('tv_heap', {
		action: 'diff',
		before: join(__dirname, 'fixture', 'heap', 'before.heapsnapshot'),
		after: join(__dirname, 'fixture', 'heap', 'after.heapsnapshot')
	});
	check('tv_heap diff needs no device and no sdb', heapDiff.delta?.totalSize === 420 && heapDiff.topGrowth?.[0]?.name === 'MovieTile',
		JSON.stringify(heapDiff.delta || heapDiff.__error));
	check('server survived a device-less tool call', s.alive());

	s.stop();
	console.log(`\n${passed} passed, ${failed} failed\n`);
	process.exit(failed ? 1 : 0);
}

main().catch((e) => {
	console.error('phase0-offline crashed:', e);
	process.exit(2);
});
