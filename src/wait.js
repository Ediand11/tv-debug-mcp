// Bounded wait-for-condition: the primitive that replaces hand-written sleeps.
//
// Every QA step on a TV is asynchronous — the app boots for ~20s, lists lazy-load, scenes
// animate. Without this every case is a pile of `sleep(22000)` guesses that are too short
// on an old set and waste minutes on a new one.
//
// A condition is one of:
//   {focusText: 'Settings'}   focused element's text contains this (case-insensitive)
//   {selector: '.popup'}      a VISIBLE element matches
//   {selectorGone: '.spinner'} no visible element matches
//   {scene: 'player'}         a visible scene's class contains this
//   {text: 'Нет интернета'}   the page's visible text contains this
//   {expression: '...'}       an ES5 expression that must evaluate truthy
//   {videoAdvancing: true}    playback position is moving (<video>, or AVPlay on old Tizen)
//   {request: {...}}          a request matching the filter was sent (see pollRequests)
//
// `stableMs` additionally requires the condition to keep holding for that long, which is
// what stops a case from acting on a half-rendered frame.

import {stateHelpersJs} from './state.js';

/**
 * Build the page-side predicate. Returns null for conditions evaluated outside the page.
 * @param {import('./appprofile.js').AppProfile} profile
 * @param {object} cond
 * @return {?string}
 */
export function conditionJs(profile, cond) {
	if (cond.videoAdvancing || cond.request) {
		return null;
	}
	let body;
	if (cond.focusText != null) {
		body = `
			var f = focusInfo();
			var hit = !!f && f.text.toLowerCase().indexOf(NEEDLE) >= 0;
			return {ok: hit, detail: f ? f.text : 'no focus'};`;
	} else if (cond.selector != null) {
		body = `
			var list = document.querySelectorAll(NEEDLE_RAW);
			for (var i = 0; i < list.length; i++) { if (visible(list[i])) { return {ok: true, detail: txt(list[i], 60)}; } }
			return {ok: false, detail: 'matches: ' + list.length + ', none visible'};`;
	} else if (cond.selectorGone != null) {
		body = `
			var list = document.querySelectorAll(NEEDLE_RAW);
			for (var i = 0; i < list.length; i++) { if (visible(list[i])) { return {ok: false, detail: 'still visible'}; } }
			return {ok: true, detail: 'gone'};`;
	} else if (cond.scene != null) {
		body = `
			var s = scenes();
			for (var i = 0; i < s.length; i++) { if (s[i].toLowerCase().indexOf(NEEDLE) >= 0) { return {ok: true, detail: s[i]}; } }
			return {ok: false, detail: s.join(' | ') || 'no visible scene'};`;
	} else if (cond.text != null) {
		body = `
			var t = (document.body.innerText || '').toLowerCase();
			return {ok: t.indexOf(NEEDLE) >= 0, detail: t.length + ' chars of text'};`;
	} else if (cond.expression != null) {
		return `(function(){
			${stateHelpersJs(profile)}
			try { var v = (${cond.expression}); return {ok: !!v, detail: String(v).slice(0, 120)}; }
			catch (e) { return {ok: false, detail: 'ERR: ' + e.message}; }
		})()`;
	} else {
		throw new Error(
			'wait condition must be one of: focusText, selector, selectorGone, scene, text, expression, ' +
			'videoAdvancing, request'
		);
	}

	const needle = String(cond.focusText ?? cond.scene ?? cond.text ?? '').toLowerCase();
	const raw = String(cond.selector ?? cond.selectorGone ?? '');
	return `(function(){
		${stateHelpersJs(profile)}
		var NEEDLE = ${JSON.stringify(needle)};
		var NEEDLE_RAW = ${JSON.stringify(raw)};
		${body}
	})()`;
}

/**
 * @param {object} cond
 * @return {string} human label for reports
 */
export function describeCondition(cond) {
	const key = Object.keys(cond)[0];
	return `${key}=${JSON.stringify(cond[key])}`;
}

/**
 * Poll a condition until it holds (and keeps holding for `stableMs`) or the deadline passes.
 * @param {{evaluate: function(string): Promise<*>, videoState: function(number): Promise<*>}} io
 * @param {import('./appprofile.js').AppProfile} profile
 * @param {object} cond
 * @param {{timeoutMs?: number, intervalMs?: number, stableMs?: number}} [opts]
 * @return {Promise<{ok: boolean, condition: string, elapsedMs: number, detail: *, polls: number}>}
 */
export async function pollUntil(io, profile, cond, opts = {}) {
	const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 15000;
	const intervalMs = opts.intervalMs != null ? opts.intervalMs : 250;
	const stableMs = opts.stableMs != null ? opts.stableMs : 0;
	const js = conditionJs(profile, cond);
	const started = Date.now();
	const deadline = started + timeoutMs;

	let polls = 0;
	let last = null;
	let okSince = null;

	while (Date.now() < deadline) {
		polls++;
		let res;
		if (js) {
			res = await io.evaluate(js).catch((e) => ({ok: false, detail: 'eval failed: ' + e.message}));
		} else {
			const v = await io.videoState(400).catch((e) => ({advancing: false, error: e.message}));
			res = {ok: !!v.advancing, detail: v};
		}
		last = res;
		if (res && res.ok) {
			if (!stableMs) {
				return {ok: true, condition: describeCondition(cond), elapsedMs: Date.now() - started, detail: res.detail, polls};
			}
			if (okSince === null) {
				okSince = Date.now();
			} else if (Date.now() - okSince >= stableMs) {
				return {ok: true, condition: describeCondition(cond), elapsedMs: Date.now() - started, detail: res.detail, polls};
			}
		} else {
			okSince = null;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return {
		ok: false,
		condition: describeCondition(cond),
		elapsedMs: Date.now() - started,
		detail: last ? last.detail : null,
		polls,
		timedOut: true
	};
}

/**
 * Wait for the network log to satisfy a request filter. This is the assertion the console
 * buffer could never make: "the analytics call went out, and it carried event_id".
 *
 * The buffer is on this side of the wire, so a poll costs nothing on the TV — no CDP call, no
 * page evaluation. Two shapes have to wait out the whole timeout instead of returning early,
 * because "not yet" and "never" are only distinguishable at the end of the window:
 *   - `absent: true` — succeeds when nothing matched;
 *   - `count.max` — a duplicate that arrives late is exactly the regression being hunted.
 *
 * @param {{networkMatches: function(object): (Promise<{count: number, samples: Array<object>}>|
 *          {count: number, samples: Array<object>})}} io
 * @param {{urlPattern?: string, method?: string, bodyContains?: string, status?: *,
 *          statusMin?: number, statusMax?: number, since?: number, absent?: boolean,
 *          count?: {min?: number, max?: number}}} cond
 * @param {{timeoutMs?: number, intervalMs?: number}} [opts]
 * @return {Promise<{ok: boolean, condition: string, elapsedMs: number, matched: number,
 *                   samples: Array<object>, polls: number, timedOut?: boolean, reason?: string}>}
 */
export async function pollRequests(io, cond, opts = {}) {
	const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 8000;
	const intervalMs = opts.intervalMs != null ? opts.intervalMs : 200;
	const absent = !!cond.absent;
	const count = cond.count || {};
	const min = absent ? 0 : (count.min != null ? Math.floor(count.min) : 1);
	const max = count.max != null ? Math.floor(count.max) : null;
	const waitWholeWindow = absent || max !== null;
	const started = Date.now();
	const deadline = started + timeoutMs;

	let polls = 0;
	let last = {count: 0, samples: []};
	for (;;) {
		polls++;
		last = (await io.networkMatches(cond)) || {count: 0, samples: []};
		const enough = !waitWholeWindow && last.count >= min;
		const left = deadline - Date.now();
		if (enough || left <= 0) {
			break;
		}
		await new Promise((r) => setTimeout(r, Math.min(intervalMs, left)));
	}

	const ok = absent
		? last.count === 0
		: last.count >= min && (max === null || last.count <= max);
	let reason = null;
	if (!ok) {
		if (absent) {
			reason = `expected no matching request, got ${last.count}`;
		} else if (last.count < min) {
			reason = `expected at least ${min} matching request(s), got ${last.count}`;
		} else {
			reason = `expected at most ${max} matching request(s), got ${last.count}`;
		}
	}
	return {
		ok,
		condition: `request=${JSON.stringify(cond)}`.slice(0, 200),
		elapsedMs: Date.now() - started,
		matched: last.count,
		// A few matches, already cut to list shape: enough to see WHICH request answered.
		samples: (last.samples || []).slice(0, 5),
		polls,
		...(ok ? {} : {reason}),
		...(!ok && !absent && last.count < min ? {timedOut: true} : {})
	};
}
