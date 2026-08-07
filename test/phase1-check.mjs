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
// Run: node test/phase1-check.mjs           (the config's defaultDevice)
//      TV_DEBUG_DEVICE=webos7 node test/phase1-check.mjs
import {startServer, makeChecker, sleep, appTargets} from './harness.mjs';

const check = makeChecker();
const DEVICE = process.env.TV_DEBUG_DEVICE || '';

async function main() {
	const target = appTargets(DEVICE || undefined);
	console.log(`  device: ${DEVICE || '(default)'}`);
	console.log(`  app profile: ${target.app} (tile ${target.tile}, popup ${target.popup || '—'})`);

	const raw = startServer('tv');
	// One place to address the device, so every call below stays as short as it reads.
	const s = {...raw, call: (name, args = {}) => raw.call(name, DEVICE ? {device: DEVICE, ...args} : args)};
	await raw.ready;

	console.log('\n--- boot ---');
	const launched = await s.call('tv_launch', {});
	check('fresh launch', !!launched.attached?.wsUrl, launched.__error);
	// The profile's bootReady is now waited on by launch itself, so the answer to "did the app
	// come up" arrives with the attach instead of taking a second round-trip per case.
	check('launch reports bootReady from the app profile',
		launched.attached?.bootReady?.ok === true,
		JSON.stringify(launched.attached?.bootReady) + (launched.attached?.warning ? ` warn=${launched.attached.warning}` : ''));
	console.log(`        (bootReady took ${launched.attached?.bootReady?.elapsedMs}ms — the old cases slept a flat 22000)`);

	const booted = await s.call('tv_wait_for', {selector: target.tile, timeoutMs: 60000, stableMs: 700});
	check('tv_wait_for replaces the boot sleep', booted.ok, `${booted.elapsedMs}ms, ${booted.polls} polls`);

	// A consent modal that traps the focus makes every navigation check below red for one and
	// the same reason. Clear it if the profile declares one — and say out loud that we did, so
	// nobody reads a green run as "the app came up ready to drive".
	if (target.dismissOnBoot) {
		const present = await s.call('tv_wait_for', {selector: target.dismissOnBoot.selector, timeoutMs: 4000});
		if (present.ok) {
			await s.call('tv_press', {key: target.dismissOnBoot.key || 'ENTER'});
			const gone = await s.call('tv_wait_for', {selectorGone: target.dismissOnBoot.selector, timeoutMs: 8000});
			check(`the boot dialog (${target.dismissOnBoot.selector}) was dismissed before navigating`, gone.ok,
				gone.detail || 'still on screen');
		} else {
			console.log(`  NOTE  no boot dialog on this set (${target.dismissOnBoot.selector})`);
		}
	}

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

	// Named targets on a real TV, using this app's own registry — nothing product-specific here.
	const tileName = Object.keys(target.elements).find((n) => /tile|card|item/i.test(n)) || Object.keys(target.elements)[0];
	if (tileName) {
		const byName = await s.call('tv_goto', {direction: 'RIGHT', element: tileName, maxSteps: 4});
		check(`tv_goto takes the named element "${tileName}" from the profile`, byName.ok,
			byName.reason || byName.__error);
		check('and echoes what the name resolved to',
			byName.resolvedFrom?.element === tileName && !!byName.resolvedFrom?.selector,
			JSON.stringify(byName.resolvedFrom));
		const typo = await s.call('tv_wait_for', {element: `${tileName}-zzz`, timeoutMs: 2000});
		check('a typo in a name fails loudly with the known names',
			!!typo.__error && /unknown element/.test(typo.__error) && typo.__error.includes(tileName),
			String(typo.__error).slice(0, 120));
	} else {
		console.log(`  SKIP  named targets — add an "elements" block to apps/${target.app}.json`);
	}

	console.log('\n--- snapshot ---');
	const layout = await s.call('tv_snapshot', {});
	check('tv_snapshot derives rows on a real TV', layout.ok && (layout.rows || []).length > 0,
		layout.warning || layout.__error || `tier=${layout.tier}`);
	console.log(`        tier=${layout.tier} rows=${layout.rows?.length} items=${layout.counts?.items} bytes=${layout.bytes}` +
		(layout.warning ? ` warning=${layout.warning}` : ''));
	console.log('        sample:', JSON.stringify((layout.rows || [])[0]?.items?.slice(0, 3).map((x) => x.t)));
	check('and the answer stays small enough to plan with', layout.bytes > 0 && layout.bytes < 6000,
		`bytes=${layout.bytes}`);
	// Rows of empty strings are a layout an agent cannot plan by. The snapshot says so in a
	// warning; the acceptance has to fail on it, or "20/20 green" hides a useless answer.
	const labelled = (layout.rows || []).reduce((n, r) => n + r.items.filter((x) => x.t).length, 0);
	check('the items carry text, not just structure', labelled > 0,
		layout.warning || 'every item came back with an empty label');
	// Take the move `neighbours` claims is one press away — that is exactly what it is for, and
	// picking an arbitrary item of the row instead is how you land on a node a virtualised list
	// has already recycled (a real TV app does that between two calls).
	const nb = layout.neighbours || {};
	const dir = ['RIGHT', 'DOWN', 'LEFT', 'UP'].find((d) => nb[d]);
	if (dir) {
		const byRef = await s.call('tv_goto', {direction: dir, ref: nb[dir], maxSteps: 4});
		check(`tv_goto {ref} lands on the element neighbours.${dir} named`, byRef.ok && byRef.presses <= 2,
			byRef.reason || `${byRef.presses} presses`);
		// The guarantee that makes refs safe at all: a ref from a previous generation is
		// refused, never re-resolved onto whatever now sits in that slot.
		await s.call('tv_snapshot', {});
		const stale = await s.call('tv_goto', {direction: dir, ref: nb[dir], maxSteps: 3});
		check('a ref from the previous snapshot is refused, not re-resolved',
			stale.ok === false && stale.presses === 0 && /snapshot/.test(String(stale.reason)),
			String(stale.reason).slice(0, 120));
	} else {
		console.log('  SKIP  tv_goto {ref} — the snapshot found no neighbour of the focus');
	}
	await s.call('tv_snapshot', {release: true});

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
	if (target.homeSection.length) {
		// Try each candidate: the park runs more than one locale, and "the section is called
		// something else on this set" is not the regression this check is about.
		let back = null;
		for (const name of target.homeSection) {
			back = await s.call('tv_menu', {item: name});
			if (back.ok) {
				break;
			}
		}
		const backOnCatalog = await s.call('tv_wait_for', {selector: target.tile, timeoutMs: 30000});
		check(`tv_menu returns from a section to the catalog (${target.homeSection.join(' / ')})`,
			back.ok && backOnCatalog.ok,
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
