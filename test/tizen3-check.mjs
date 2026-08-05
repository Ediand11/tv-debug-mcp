// Old-Tizen acceptance: the Chromium 47 adaptations end-to-end on a real set.
//
// Tizen 3.0 (Chromium 47, CDP protocol 1.1) breaks four things that every newer engine in the
// park gets right, and each check below pins one of the fixes:
//
//   1. tv_launch attaches, and the engine really is a pre-M54 Chromium
//   2. tv_wait_for settles the boot without a blind sleep
//   3. tv_evaluate returns a synchronous value (unchanged path, one round-trip)
//   4. a page-side promise resolves to its VALUE, not to the serialized pending promise
//   5. a rejected promise surfaces as an error with the page-side message
//   6. a bare `throw` statement still reports itself (the wrapper falls back unwrapped)
//   7. tv_video_state answers structurally with no player open
//   8. with a stream playing it reads webapis.avplay: advancing, codec, bitrate ladder
//      (auto-opened if the app gets there; otherwise re-run with TV_DEBUG_PLAYING=1)
//   9. tv_profile action:"metrics" falls back to Memory.getDOMCounters instead of failing,
//      and does not invent a heap number
//  10. tv_screenshot refuses the SECOND call instantly instead of burning the timeout again
//  11. console and network still report, and the session survives all of it
//
// The inspector on this generation is single-user: while the MCP holds the WebSocket,
// /json/list withholds webSocketDebuggerUrl and a second connection gets HTTP 500. So run this
// through the MCP (as here) — not alongside a hand-rolled probe on the same TV.
//
// Run: TV_DEBUG_DEVICE=tizen3 node test/tizen3-check.mjs
import {startServer, makeChecker, appTargets, sleep} from './harness.mjs';

const DEVICE = process.env.TV_DEBUG_DEVICE || 'tizen3';
/** Set when playback was started by hand: check 8 then asserts instead of trying to navigate. */
const ALREADY_PLAYING = process.env.TV_DEBUG_PLAYING === '1';
const check = makeChecker();

/** @return {Promise<object>} the video state, or the error envelope */
async function videoState(s) {
	return s.call('tv_video_state', {device: DEVICE, sampleGapMs: 1200});
}

async function main() {
	const target = appTargets(DEVICE);
	console.log(`  app profile: ${target.app} (tile ${target.tile})`);

	const s = startServer('tv');
	await s.ready;

	console.log('\n--- boot ---');
	const launched = await s.call('tv_launch', {device: DEVICE});
	check('fresh launch attaches', !!launched.attached?.wsUrl, launched.__error);

	const booted = await s.call('tv_wait_for', {
		device: DEVICE, selector: target.tile, timeoutMs: target.bootTimeoutMs, stableMs: 700
	});
	check('tv_wait_for sees the app boot', booted.ok, booted.__error || `${booted.elapsedMs}ms`);

	console.log('\n--- evaluate (no awaitPromise on this protocol) ---');
	const ua = await s.call('tv_evaluate', {device: DEVICE, expression: 'navigator.userAgent'});
	check('tv_evaluate returns a synchronous value', typeof ua.value === 'string' && ua.value.length > 0,
		JSON.stringify(ua).slice(0, 120));
	// M54 is where awaitPromise/exceptionDetails landed; below it the fallback is what runs.
	// The Tizen 3 webview UA carries NO Chrome token at all ("SMART-TV; LINUX; Tizen 3.0 …
	// AppleWebKit/538.1"), so the test is "no modern Chrome", not "an old Chrome number".
	const chromeMajor = Number((String(ua.value || '').match(/Chrome\/(\d+)/) || [])[1] || 0);
	check('the engine is not a modern Chromium (so the legacy path is what is under test)',
		chromeMajor < 54, `Chrome/${chromeMajor || 'none'} — ${String(ua.value).slice(0, 90)}`);

	const prom = await s.call('tv_evaluate', {
		device: DEVICE,
		expression: 'new Promise(function(r){ setTimeout(function(){ r({answer: 42}); }, 300); })'
	});
	check('a page-side promise resolves to its value',
		prom.value && prom.value.answer === 42, JSON.stringify(prom).slice(0, 160));

	const rejected = await s.call('tv_evaluate', {
		device: DEVICE,
		expression: 'new Promise(function(res, rej){ rej(new Error("tizen3-check-reject")); })'
	});
	check('a rejected promise surfaces as an error',
		!!rejected.__error && rejected.__error.includes('tizen3-check-reject'), JSON.stringify(rejected).slice(0, 160));

	const thrown = await s.call('tv_evaluate', {device: DEVICE, expression: 'throw new Error("tizen3-check-boom")'});
	check('a bare throw statement still reports itself',
		!!thrown.__error && thrown.__error.includes('tizen3-check-boom'), JSON.stringify(thrown).slice(0, 160));

	console.log('\n--- video state (AVPlay, not <video>) ---');
	const idle = await videoState(s);
	check('tv_video_state answers structurally with nothing playing',
		!idle.__error && typeof idle.found === 'number', idle.__error || JSON.stringify(idle).slice(0, 160));

	let playing = ALREADY_PLAYING ? await videoState(s) : null;
	if (!ALREADY_PLAYING) {
		// Best effort, and deliberately not a navigation script: open whatever the focused tile
		// opens, give it a moment, and press again for apps that need a second confirm.
		await s.call('tv_press', {device: DEVICE, key: 'ENTER'});
		await sleep(4000);
		await s.call('tv_press', {device: DEVICE, key: 'ENTER'});
		const advancing = await s.call('tv_wait_for', {device: DEVICE, videoAdvancing: true, timeoutMs: 40000});
		if (advancing.ok) {
			check('tv_wait_for videoAdvancing passes on the object player', true, `${advancing.elapsedMs}ms`);
			playing = await videoState(s);
		} else {
			console.log('  SKIP  playback checks — the app did not reach a player by itself.');
			console.log('        Start a video by hand and re-run with TV_DEBUG_PLAYING=1.');
		}
	}
	if (playing) {
		check('a playing stream reads as found and advancing',
			playing.found === 1 && playing.advancing === true,
			JSON.stringify(playing).slice(0, 200));
		check('and it came from AVPlay with codec and bitrate',
			playing.source === 'avplay' && !!playing.codec && typeof playing.bitrate === 'number',
			JSON.stringify(playing).slice(0, 200));
	}

	console.log('\n--- metrics (no Performance domain here) ---');
	const metrics = await s.call('tv_profile', {device: DEVICE, action: 'metrics'});
	check('tv_profile metrics answers instead of failing',
		!metrics.__error && metrics.metrics && typeof metrics.metrics.Nodes === 'number',
		metrics.__error || JSON.stringify(metrics).slice(0, 200));
	const warned = (metrics.warnings || []).join(' ');
	if (warned.includes('Memory.getDOMCounters')) {
		check('the DOM-counter fallback carries listeners and a timestamp',
			typeof metrics.metrics.JSEventListeners === 'number' && typeof metrics.metrics.Timestamp === 'number',
			JSON.stringify(metrics.metrics));
		check('and invents no heap number (performance.memory is quantized)',
			metrics.metrics.JSHeapUsedSize === undefined, JSON.stringify(metrics.metrics));
	} else {
		check('this engine has the real Performance domain (fallback not exercised)',
			typeof metrics.metrics?.JSHeapUsedSize === 'number', JSON.stringify(metrics.metrics).slice(0, 160));
	}

	console.log('\n--- screenshot fast-fail ---');
	const firstAt = Date.now();
	const first = await s.call('tv_screenshot', {device: DEVICE, timeoutMs: 5000});
	const firstMs = Date.now() - firstAt;
	if (first.ok) {
		check('this engine can capture a frame (fast-fail path not exercised)', true, `${firstMs}ms`);
	} else {
		const secondAt = Date.now();
		const second = await s.call('tv_screenshot', {device: DEVICE, timeoutMs: 5000});
		const secondMs = Date.now() - secondAt;
		check('the second screenshot refuses instantly instead of hanging again',
			second.ok === false && secondMs < 1500, `first ${firstMs}ms, second ${secondMs}ms`);
		check('the refusal explains itself and points somewhere useful',
			/earlier in this session/.test(second.reason || '') && /tv_video_state/.test(second.reason || ''),
			String(second.reason).slice(0, 160));
	}

	console.log('\n--- console, network, survival ---');
	await s.call('tv_evaluate', {device: DEVICE, expression: 'console.log("tizen3-check-marker"); "ok"'});
	const con = await s.call('tv_console', {device: DEVICE});
	const entries = [...(con.console || []), ...(con.errors || [])];
	check('tv_console sees the marker', entries.some((e) => String(e.text || '').includes('tizen3-check-marker')),
		entries.slice(-3).map((e) => e.text).join(' | ').slice(0, 140));

	// action:"list" answers with {requests, dropped, …} — `totals` is tv_console's shape, and an
	// app sitting idle can legitimately have sent nothing since the window opened.
	const net = await s.call('tv_network', {device: DEVICE, limit: 5});
	check('tv_network answers with a log', !net.__error && Array.isArray(net.requests),
		net.__error || JSON.stringify(net).slice(0, 160));

	const alive = await s.call('tv_evaluate', {device: DEVICE, expression: '2*21'});
	check('the session survives everything above', alive.value === 42, JSON.stringify(alive).slice(0, 120));

	s.stop();
	process.exit(check.summary() ? 1 : 0);
}

main().catch((e) => {
	console.error('tizen3-check crashed:', e);
	process.exit(2);
});
