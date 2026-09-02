// Vidaa (Hisense) acceptance: the attach-only CDP path end-to-end on a real TV.
//
// Vidaa is the simplest platform in the park — a full Chromium (111 on VIDAA 9) whose
// DevTools endpoint listens on the TV itself after the remote key-sequence. No CLI, no
// forwarding, no legacy dialect. Each check pins one property of that setup:
//
//   1. tv_devices reports the vidaa device online (inspector answers /json/version)
//   2. tv_launch attaches over /json/list and derives a /devtools/page ws url
//   3. tv_wait_for settles the boot without a blind sleep
//   4. tv_evaluate returns values synchronously, and the engine really is Chromium 111+
//   5. a returned Promise is awaited by the protocol (modern dialect, no host-side settling)
//   6. tv_console captures entries since attach
//   7. tv_press moves focus with synthetic keys (DOWN then UP)
//   8. tv_press BACK dispatches code 8 — not 461 (webOS) and not 10009 (Tizen)
//   9. tv_network sees the app's traffic
//  10. tv_video_state answers structurally in idle (no video on home is fine)
//  11. playback: ENTER on a tile → videoAdvancing → codec, then BACK out
//  12. tv_screenshot either works (Chromium 111 bonus) or refuses honestly
//  13. tv_launch relaunch reloads the page in place (the only relaunch Vidaa has)
//
// Precondition: dev mode enabled on the TV with the remote, the app is running.
// Run: node test/vidaa-check.mjs
import {startServer, makeChecker, appTargets, sleep} from './harness.mjs';

// Override for a park whose Vidaa device is registered under another id.
const DEVICE = process.env.TV_DEBUG_DEVICE || 'vidaa';
const check = makeChecker();

async function main() {
	const target = appTargets(DEVICE);
	console.log(`  app profile: ${target.app} (tile ${target.tile})`);

	const s = startServer('tv');
	await s.ready;

	console.log('\n--- reachability ---');
	const parked = await s.call('tv_devices', {});
	const row = (parked.devices || []).find((d) => d.id === DEVICE);
	check('tv_devices lists the vidaa device', !!row, parked.__error);
	check('inspector answers /json/version (online)', row?.status === 'online', row?.status);
	check('capabilities are honest (no install/kill, relaunch yes)',
		row?.capabilities?.install === false && row?.capabilities?.killApp === false && row?.capabilities?.relaunch === true,
		JSON.stringify(row?.capabilities));

	console.log('\n--- boot ---');
	const launched = await s.call('tv_launch', {device: DEVICE});
	check('attach derives a ws url from /json/list', launched.ok === true, launched.__error);
	check('launch reports rttMs and a modern eval dialect',
		typeof launched.rttMs === 'number' && launched.legacyEval === undefined, JSON.stringify(launched).slice(0, 160));

	const booted = await s.call('tv_wait_for', {device: DEVICE, selector: target.tile, timeoutMs: target.bootTimeoutMs, stableMs: 700});
	check('tv_wait_for sees the app booted', booted.ok, booted.__error || `${booted.elapsedMs}ms`);

	console.log('\n--- evaluate ---');
	const ua = await s.call('tv_evaluate', {device: DEVICE, expression: 'navigator.userAgent'});
	check('tv_evaluate returns a value', typeof ua.value === 'string' && ua.value.length > 0, JSON.stringify(ua).slice(0, 120));
	check('engine is a modern Chromium (Vidaa UA)', /Chrome\/1\d\d/.test(String(ua.value || '')), ua.value);

	const sync = await s.call('tv_evaluate', {device: DEVICE, expression: '2*21'});
	check('sync evaluate', sync.value === 42, JSON.stringify(sync).slice(0, 120));

	const prom = await s.call('tv_evaluate', {device: DEVICE, expression: 'Promise.resolve(6*7)'});
	check('a returned Promise settles via awaitPromise (modern dialect)',
		prom.value === 42, JSON.stringify(prom).slice(0, 160));

	console.log('\n--- console ---');
	await s.call('tv_evaluate', {device: DEVICE, expression: 'console.log("vidaa-check-marker"); "ok"'});
	const con = await s.call('tv_console', {device: DEVICE});
	const entries = [...(con.console || []), ...(con.errors || [])];
	check('tv_console sees the marker', entries.some((e) => String(e.text || '').includes('vidaa-check-marker')),
		entries.slice(-3).map((e) => e.text).join(' | ').slice(0, 140));

	console.log('\n--- press ---');
	// Tiles exist before their titles render; wait for the focused tile's text so a real
	// move does not read as "no movement" between two identical skeletons.
	for (let i = 0; i < 30; i++) {
		const now = await s.call('tv_state', {device: DEVICE, format: 'json'});
		if (String(now.focus?.text || '').trim()) {
			break;
		}
		await sleep(700);
	}
	const down = await s.call('tv_press', {device: DEVICE, key: 'DOWN'});
	check('tv_press dispatches synthetic keys', !down.__error && down.keyCode === 40, down.__error);
	check('tv_press reports focus movement', down.changed === true,
		`before=${String(down.before).slice(0, 60)} after=${String(down.focus).slice(0, 60)}`);
	await s.call('tv_press', {device: DEVICE, key: 'UP'});

	const back = await s.call('tv_press', {device: DEVICE, key: 'BACK'});
	check('BACK resolves to code 8 (Vidaa Backspace, not 461/10009)',
		!back.__error && back.keyCode === 8, back.__error || `keyCode=${back.keyCode}`);

	console.log('\n--- network ---');
	const net = await s.call('tv_network', {device: DEVICE});
	check('tv_network answers structurally', !net.__error && Array.isArray(net.requests), net.__error);

	console.log('\n--- video state ---');
	const idle = await s.call('tv_video_state', {device: DEVICE});
	check('tv_video_state answers structurally in idle', !idle.__error && typeof idle.found === 'number',
		idle.__error || JSON.stringify(idle).slice(0, 120));

	// Playback: enter the focused tile, wait for a real advancing <video>, read the codec,
	// then back out. This is the check the platform exists for — the verdict path without a
	// screenshot. Skippable for a quick smoke: VIDAA_CHECK_SKIP_PLAYBACK=1.
	if (process.env.VIDAA_CHECK_SKIP_PLAYBACK !== '1') {
		console.log('\n--- playback ---');
		// The presses above may have parked the focus anywhere (menu, a promo tile with its
		// own action). ENTER on a promo opens its own flow, not the player — so walk the grid
		// until the focus really is a content tile (the app profile's tile selector) before
		// entering it.
		const tileClasses = String(target.tile).split(',')
			.map((sel) => sel.trim().replace(/^\./, '')).filter(Boolean);
		let onTile = false;
		// RIGHT first: it leaves the sidebar menu for the content grid and is harmless on a
		// tile row; no BACK here — from the menu BACK raises the exit popup.
		const walk = ['RIGHT', 'DOWN', 'RIGHT', 'DOWN', 'DOWN', 'RIGHT', 'DOWN', 'RIGHT'];
		for (let i = 0; i <= walk.length; i++) {
			const now = await s.call('tv_state', {device: DEVICE, format: 'json'});
			const path = String(now.focus?.path || '');
			if (tileClasses.some((c) => path.includes(c)) && !/banner/.test(path)) {
				onTile = true;
				break;
			}
			if (i < walk.length) {
				await s.call('tv_press', {device: DEVICE, key: walk[i]});
				await sleep(600);
			}
		}
		check('focus lands on a video tile before ENTER', onTile);
		await s.call('tv_press', {device: DEVICE, key: 'ENTER'});
		const advancing = await s.call('tv_wait_for', {device: DEVICE, videoAdvancing: true, timeoutMs: 45000});
		check('video starts advancing after ENTER on a tile', advancing.ok === true,
			advancing.__error || JSON.stringify(advancing).slice(0, 140));
		if (advancing.ok) {
			const vs = await s.call('tv_video_state', {device: DEVICE});
			check('playback goes through HTML5 <video> (found ≥ 1)', vs.found >= 1, JSON.stringify(vs).slice(0, 120));
			check('tv_video_state reports dimensions/src of the playing video',
				(vs.videoWidth > 0 && vs.videoHeight > 0) || !!vs.src,
				JSON.stringify(vs).slice(0, 200));
		}
		await s.call('tv_press', {device: DEVICE, key: 'BACK'});
		await sleep(1500);
		await s.call('tv_press', {device: DEVICE, key: 'BACK'});
	}

	console.log('\n--- screenshot ---');
	const shot = await s.call('tv_screenshot', {device: DEVICE});
	check('tv_screenshot works or refuses honestly',
		!!shot.path || !!shot.__error || (shot.ok === false && !!shot.note),
		JSON.stringify(shot).slice(0, 120));
	const alive = await s.call('tv_evaluate', {device: DEVICE, expression: '2*21'});
	check('session survives the screenshot attempt', alive.value === 42, JSON.stringify(alive).slice(0, 120));

	console.log('\n--- relaunch = reload in place ---');
	const relaunched = await s.call('tv_launch', {device: DEVICE, relaunch: true});
	check('relaunch reattaches (page reloaded in place)', relaunched.ok === true, relaunched.__error);
	const rebooted = await s.call('tv_wait_for', {device: DEVICE, selector: target.tile, timeoutMs: target.bootTimeoutMs, stableMs: 700});
	check('the app boots again after the reload', rebooted.ok, rebooted.__error || `${rebooted.elapsedMs}ms`);

	s.stop();
	process.exit(check.summary() ? 1 : 0);
}

main().catch((e) => {
	console.error('vidaa-check crashed:', e);
	process.exit(2);
});
