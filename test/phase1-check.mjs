// Phase-1 acceptance: semantic navigation on a real TV.
//
//   1. tv_wait_for replaces the boot sleep and reports how long it actually took
//   2. tv_state returns a structured focus (path, index/total, testid), not one string
//   3. tv_goto reaches a tile by its text and reports every press
//   4. tv_goto on a target that does not exist stops on its own bound — no infinite loop
//   5. tv_menu opens the sidebar and selects a section by name
//   6. tv_sequence runs the whole catalog-longtap case in one call with a verdict per step
//
// Selectors and section names come from the device's app profile (see `appTargets`), so this
// runs against any app that has one — nothing here is pinned to a particular product.
//
// Run: node test/phase1-check.mjs
import {startServer, makeChecker, sleep, appTargets} from './harness.mjs';

const check = makeChecker();

async function main() {
	const target = appTargets();
	console.log(`  app profile: ${target.app} (tile ${target.tile}, popup ${target.popup || '—'})`);

	const s = startServer('tv');
	await s.ready;

	console.log('\n--- boot ---');
	const launched = await s.call('tv_launch', {});
	check('fresh launch', !!launched.attached?.wsUrl, launched.__error);

	const booted = await s.call('tv_wait_for', {selector: target.tile, timeoutMs: 60000, stableMs: 700});
	check('tv_wait_for replaces the boot sleep', booted.ok, `${booted.elapsedMs}ms, ${booted.polls} polls`);
	console.log(`        (boot took ${booted.elapsedMs}ms — the old cases slept a flat 22000)`);

	console.log('\n--- state ---');
	const st = await s.call('tv_state');
	check('tv_state returns a structured focus',
		!!st.focus && typeof st.focus.index === 'number' && !!st.focus.path,
		JSON.stringify(st.focus).slice(0, 140));
	check('tv_state sees the catalog', (st.counts?.tiles || 0) > 0, `tiles=${st.counts?.tiles}`);

	console.log('\n--- goto ---');
	// Pick a tile a few positions to the right and travel to it by its text.
	// Tiles exist before their titles render, so poll until one actually has text —
	// "the selector is visible" is not the same as "the content is there".
	const pickTile = `(function(){
		var t = document.querySelectorAll('${target.tile}');
		var el = t[4] || t[t.length-1];
		if (!el) { return ''; }
		return (el.innerText||'').replace(/\\s+/g,' ').replace(/^\\s+|\\s+$/g,'').slice(0, 24);
	})()`;
	let needle = '';
	for (let i = 0; i < 20 && !needle; i++) {
		const targetText = await s.call('tv_evaluate', {expression: pickTile});
		needle = String(targetText.value || '').trim();
		if (!needle) {
			await sleep(500);
		}
	}
	if (!needle) {
		check('picked a target tile text', false, 'no tile text found');
	} else {
		console.log(`        target: "${needle}"`);
		const goto = await s.call('tv_goto', {direction: 'RIGHT', text: needle, maxSteps: 12});
		check('tv_goto reaches a tile by text', goto.ok, goto.reason || `${goto.presses} presses`);
		check('tv_goto reports every press', Array.isArray(goto.steps) && goto.steps.length === goto.presses,
			`steps=${goto.steps?.length} presses=${goto.presses}`);
	}

	const nowhere = await s.call('tv_goto', {direction: 'RIGHT', text: 'no-such-tile-anywhere-zzz', maxSteps: 6});
	check('tv_goto stops on its own bound', nowhere.ok === false && !!nowhere.reason, nowhere.reason);

	console.log('\n--- menu ---');
	const opened = await s.call('tv_menu', {select: false});
	check('tv_menu opens the sidebar', opened.ok && (opened.items || []).length > 0,
		opened.reason || (opened.items || []).slice(0, 4).join(' / '));

	const sections = opened.items || [];
	const pick = sections.find((x) => /settings|настройк/i.test(x)) || sections[sections.length - 1];
	const chosen = await s.call('tv_menu', {item: pick});
	check(`tv_menu selects "${pick}"`, chosen.ok, chosen.reason || JSON.stringify(chosen.state?.focus?.text));

	// Round-trip back out of the section. This is the regression that mattered: a section can
	// render its own rows as menu cells (one of them named like a top-level section), so a
	// text-only match used to select a nested row and report success while the app never left.
	// Needs `checks.homeSection` in the app profile — the name of the section to come back to.
	if (target.homeSection) {
		const back = await s.call('tv_menu', {item: target.homeSection});
		const backOnCatalog = await s.call('tv_wait_for', {selector: target.tile, timeoutMs: 30000});
		check('tv_menu returns from a section to the catalog', back.ok && backOnCatalog.ok,
			back.reason || `presses=${back.presses} scene=${JSON.stringify(back.state?.scenes)}`);
	} else {
		console.log(`  SKIP  tv_menu round-trip — add "checks": {"homeSection": "…"} to apps/${target.app}.json`);
	}
	await sleep(500);

	console.log('\n--- sequence: catalog longtap case ---');
	// The long-press half needs to know what the tile's context menu looks like: put it in
	// the app profile as `checks.popup`. Without it the case still runs, minus the assertions.
	const longtapSteps = target.popup
		? [
			{longpress: 'ENTER', durationMs: 1600},
			{expect: {selector: target.popup}, timeoutMs: 8000},
			{press: 'BACK'},
			{expect: {selectorGone: target.popup}, timeoutMs: 8000}
		]
		: [{longpress: 'ENTER', durationMs: 1600}, {press: 'BACK'}];
	if (!target.popup) {
		console.log(`  NOTE  no popup assertions — add "checks": {"popup": "…"} to apps/${target.app}.json`);
	}
	const seq = await s.call('tv_sequence', {
		steps: [
			// establish the precondition inside the case: the menu excursion above may have
			// left the app anywhere, and a case that assumes "we are on the catalog" is a
			// case that passes only on a lucky ordering
			{launch: {relaunch: true}},
			{wait: {selector: target.tile}, timeoutMs: 60000},
			// the catalog keeps rendering for a beat after the scene switches; long-pressing
			// into a still-settling row is how you get "nothing happened"
			{sleep: 1500},
			{goto: {direction: 'RIGHT', selector: target.tile, maxSteps: 3}},
			...longtapSteps
		]
	});
	check('tv_sequence ran every step', seq.ran === seq.of, `${seq.ran}/${seq.of}, failedAt=${seq.failedAt}`);
	check('tv_sequence: longtap opens the tile context menu', seq.ok,
		JSON.stringify(seq.steps?.map((x) => `${x.step}=${x.ok}`)));
	for (const st2 of seq.steps || []) {
		console.log(`        ${st2.ok ? 'ok ' : 'FAIL'} ${st2.elapsedMs}ms  ${st2.step}`);
	}

	s.stop();
	process.exit(check.summary() ? 1 : 0);
}

main().catch((e) => {
	console.error('phase1-check crashed:', e);
	process.exit(2);
});
