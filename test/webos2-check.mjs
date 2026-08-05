// webOS 2 acceptance: the legacy WebKit inspector path end-to-end on a real TV.
//
// webOS 2 (WebKit 538) has no CDP: discovery is /pagelist.json, evaluate replies carry
// `wasThrown`, KeyboardEvent is not constructible and the protocol ignores `awaitPromise`.
// Each check below pins one of those adaptations:
//
//   1. tv_launch fresh-starts the app and derives the WS endpoint from /pagelist.json
//   2. tv_wait_for settles the boot without a blind sleep
//   3. tv_evaluate returns values by value, and the engine really is WebKit 538
//   4. a page-side throw surfaces as an error — not the silent undefined it was
//   5. tv_console reports entries captured via Console.messageAdded since launch
//   6. tv_state returns a structured focus
//   7. tv_press moves focus through the createEvent fallback
//   8. tv_video_state answers structurally via the two-call sample (no video on home is fine)
//   9. tv_screenshot fails honestly and the session survives it
//  10. tv_sequence runs a three-step case under the device lock
//
// Run: node test/webos2-check.mjs
import {startServer, makeChecker, appTargets, sleep} from './harness.mjs';

// Override for a park whose legacy-WebKit device is registered under another id.
const DEVICE = process.env.TV_DEBUG_DEVICE || 'webos2';
const check = makeChecker();

async function main() {
	const target = appTargets(DEVICE);
	console.log(`  app profile: ${target.app} (tile ${target.tile})`);

	const s = startServer('tv');
	await s.ready;

	console.log('\n--- boot ---');
	const launched = await s.call('tv_launch', {device: DEVICE});
	check('fresh launch attaches over /pagelist.json', !!launched.attached?.wsUrl, launched.__error);
	check('derived ws url has the /devtools/page shape',
		String(launched.attached?.wsUrl || '').includes('/devtools/page/'), launched.attached?.wsUrl);

	const booted = await s.call('tv_wait_for', {device: DEVICE, selector: target.tile, timeoutMs: target.bootTimeoutMs, stableMs: 700});
	check('tv_wait_for sees the app boot', booted.ok, booted.__error || `${booted.elapsedMs}ms`);

	console.log('\n--- evaluate ---');
	const ua = await s.call('tv_evaluate', {device: DEVICE, expression: 'navigator.userAgent'});
	check('tv_evaluate returns a value', typeof ua.value === 'string' && ua.value.length > 0, JSON.stringify(ua).slice(0, 120));
	check('engine is legacy WebKit 538', String(ua.value || '').includes('538'), ua.value);

	const thrown = await s.call('tv_evaluate', {device: DEVICE, expression: 'throw new Error("webos2-check-boom")'});
	check('page-side throw surfaces as an error (wasThrown)',
		!!thrown.__error && thrown.__error.includes('webos2-check-boom'), JSON.stringify(thrown).slice(0, 160));

	console.log('\n--- console ---');
	await s.call('tv_evaluate', {device: DEVICE, expression: 'console.log("webos2-check-marker"); "ok"'});
	const con = await s.call('tv_console', {device: DEVICE});
	const entries = [...(con.console || []), ...(con.errors || [])];
	check('tv_console captured entries since launch', entries.length > 0, `entries=${entries.length}`);
	check('tv_console sees the marker', entries.some((e) => String(e.text || '').includes('webos2-check-marker')),
		entries.slice(-3).map((e) => e.text).join(' | ').slice(0, 140));

	console.log('\n--- state & press ---');
	const st = await s.call('tv_state', {device: DEVICE});
	check('tv_state returns a structured focus', !!st.focus && !!st.focus.path, JSON.stringify(st.focus).slice(0, 140));

	// Tiles exist before their titles render; two skeleton tiles produce identical focus
	// snapshots and a real move reads as "no movement". Wait for the focused tile's text.
	for (let i = 0; i < 30; i++) {
		const now = await s.call('tv_state', {device: DEVICE});
		if (String(now.focus?.text || '').trim()) {
			break;
		}
		await sleep(700);
	}

	const press = await s.call('tv_press', {device: DEVICE, key: 'RIGHT'});
	check('tv_press dispatches through the createEvent fallback', !press.__error && press.keyCode === 39, press.__error);
	check('tv_press reports focus movement', press.focusChanged === true,
		`before=${String(press.focusedBefore).slice(0, 60)} after=${String(press.focusedAfter).slice(0, 60)}`);
	await s.call('tv_press', {device: DEVICE, key: 'LEFT'});

	console.log('\n--- video state ---');
	const vs = await s.call('tv_video_state', {device: DEVICE});
	check('tv_video_state answers structurally', !vs.__error && typeof vs.found === 'number', vs.__error || JSON.stringify(vs).slice(0, 120));

	console.log('\n--- honest refusals ---');
	const shot = await s.call('tv_screenshot', {device: DEVICE});
	check('tv_screenshot refuses honestly', !!shot.__error || (shot.ok === false && !!shot.note),
		JSON.stringify(shot).slice(0, 120));
	const alive = await s.call('tv_evaluate', {device: DEVICE, expression: '2*21'});
	check('session survives the refused screenshot', alive.value === 42, JSON.stringify(alive).slice(0, 120));

	console.log('\n--- sequence ---');
	const seq = await s.call('tv_sequence', {device: DEVICE, steps: [
		{press: 'DOWN'},
		{wait: {selector: target.tile}, timeoutMs: 10000},
		{state: true}
	]});
	check('tv_sequence runs a case end-to-end', seq.ok === true && (seq.steps || []).length === 3,
		seq.__error || JSON.stringify(seq.steps?.map((x) => x.ok)).slice(0, 80));

	s.stop();
	process.exit(check.summary() ? 1 : 0);
}

main().catch((e) => {
	console.error('webos2-check crashed:', e);
	process.exit(2);
});
