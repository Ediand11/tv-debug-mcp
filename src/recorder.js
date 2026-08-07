// Turn "what a person did with the remote" into a runnable tv_sequence, plus the checklist of
// what only a human can confirm.
//
// The compiler is a pure function of a timeline, which is the whole point: every pass below is
// testable without a TV, and the passes are where the judgement lives.
//
//   P0 pair      d/u -> {key, holdMs, repeats}. An unknown keyCode stays a number; resolveKey
//                takes numbers, so the case still replays.
//   P1 classify  auto-repeat on a d-pad -> {press, repeat}, NOT longpress: holding DOWN on a TV
//                is the platform repeating the key, while a synthetic long-press sends exactly
//                ONE keydown and would scroll nothing. Genuine hold on a non-d-pad key ->
//                {longpress}.
//   P2 collapse  a run of the same d-pad key -> one {goto}, but ONLY if the focus signature
//                moved on EVERY press. Stopped halfway = the person overshot an edge; recording
//                somebody else's overshoot produces a case that is green for the wrong reason.
//   P3 assert    observations become waits and expects: a scene change, a popup that appeared
//                or went away, video that started moving.
//   P4 idle      a pause with nothing changing is DROPPED. `sleep` is never emitted — cases/
//                README.md forbids it outright, and baking in somebody's thinking time is the
//                worst thing a recorder can do.
//   P5 network   only what the profile's `record.watch` whitelist names. No whitelist -> zero
//                network steps, because otherwise every case gets forty assertions on a CDN.
//                `bodyContains` is never inferred: a recorded body carries tokens and ids, so
//                that assertion is green once and red forever after.
//   P6 frame     always {launch:{relaunch:true}} first (cases/README.md, rule #1).

import {keyNameFor, DPAD_NAMES} from './keymaps.js';

/** Below this a "hold" is just a normal press with human-slow fingers. */
const DEFAULT_LONG_PRESS_MS = 700;
/** A wait timeout derived from an observation: 3x what we saw, floored and capped. */
const WAIT_MIN_MS = 5000;
const WAIT_MAX_MS = 30000;

/**
 * @typedef {{k: string, ts: number, c?: number, rp?: number, tr?: ?number,
 *            f?: string, fx?: string, fi?: ?string, sc?: string, pp?: string, v?: ?object}} RecEvent
 */

/**
 * Host-side accumulator. Page timestamps are converted to host time here and nowhere else:
 * a TV with a wrong clock is normal, and the network log deliberately stamps with host time
 * for exactly the same reason.
 */
export class Timeline {
	constructor() {
		/** @type {Array<RecEvent>} */
		this.events = [];
		this.dropped = 0;
		this.reinstalls = 0;
		this.gaps = [];
		this._t0 = null;
		this._t0Host = null;
	}

	/**
	 * @param {number} pageT0 page-side Date.now() at install
	 * @param {number} hostNow host Date.now() in the same tick
	 */
	setClock(pageT0, hostNow) {
		this._t0 = pageT0;
		this._t0Host = hostNow;
	}

	/** @param {number} pageTs @return {number} */
	toHost(pageTs) {
		if (this._t0 == null || this._t0Host == null) {
			return pageTs;
		}
		return this._t0Host + (pageTs - this._t0);
	}

	/**
	 * @param {Array<RecEvent>} events
	 * @param {number} dropped
	 */
	add(events, dropped) {
		for (const e of events || []) {
			this.events.push({...e, ts: this.toHost(e.ts)});
		}
		this.dropped += dropped || 0;
	}

	/**
	 * The connection died and came back: page-side state went with the old V8. Recorded as a
	 * marker so the compiler — and the human reading the checklist — can see the hole rather
	 * than a smooth timeline that quietly lost events.
	 * @param {number} atHostMs
	 */
	markReattach(atHostMs) {
		this.reinstalls++;
		this.events.push({k: 'reattach', ts: atHostMs});
	}

	get keyCount() {
		return this.events.filter((e) => e.k === 'd').length;
	}
}

/**
 * P0: pair keydown/keyup into presses.
 * @param {Array<RecEvent>} events
 * @param {string} platform
 * @return {Array<object>} presses in order
 */
function pairKeys(events, platform) {
	const out = [];
	/** @type {Map<number, object>} */
	const open = new Map();
	for (const e of events) {
		if (e.k === 'd') {
			const cur = open.get(e.c);
			if (cur) {
				// A repeat keydown with no keyup between: the platform auto-repeating a held key.
				cur.repeats++;
				cur.lastDownTs = e.ts;
				continue;
			}
			open.set(e.c, {
				code: e.c, name: keyNameFor(platform, e.c), downTs: e.ts, lastDownTs: e.ts,
				repeats: 1, trusted: e.tr === undefined ? null : e.tr
			});
		} else if (e.k === 'u') {
			const cur = open.get(e.c);
			if (!cur) {
				continue;
			}
			open.delete(e.c);
			cur.upTs = e.ts;
			cur.holdMs = Math.max(0, e.ts - cur.downTs);
			out.push(cur);
		}
	}
	// A key still held when the recording stopped: keep it, with what we know.
	for (const cur of open.values()) {
		cur.upTs = cur.lastDownTs;
		cur.holdMs = Math.max(0, cur.lastDownTs - cur.downTs);
		cur.unreleased = true;
		out.push(cur);
	}
	return out.sort((a, b) => a.downTs - b.downTs);
}

/**
 * P1: what kind of step is this press?
 * @param {object} press
 * @param {number} longPressMs
 * @return {object} a tv_sequence step
 */
function classify(press, longPressMs) {
	const isDpad = DPAD_NAMES.indexOf(String(press.name)) >= 0;
	const burst = () => {
		const span = Math.max(0, press.lastDownTs - press.downTs);
		const step = {press: press.name, repeat: press.repeats};
		const interval = Math.round(span / Math.max(1, press.repeats - 1));
		if (interval > 0) {
			step.intervalMs = Math.min(2000, Math.max(30, interval));
		}
		return step;
	};
	if (isDpad && press.repeats > 1) {
		// Physical auto-repeat on a direction means "keep moving". NOT a long-press:
		// {longpress} sends exactly one keydown and would move the focus once.
		return burst();
	}
	if (press.holdMs >= longPressMs) {
		// A held non-direction key is a hold in the app's own terms — LongPressService starts
		// its timer on keydown and lets keyup decide.
		return {longpress: press.name, durationMs: Math.round(press.holdMs)};
	}
	if (press.repeats > 1) {
		return burst();
	}
	return {press: press.name};
}

/**
 * The focus signature at (or just after) a given moment, from the observation stream.
 * @param {Array<RecEvent>} obs
 * @param {number} ts
 * @return {?RecEvent}
 */
function obsAfter(obs, ts) {
	for (const o of obs) {
		if (o.ts >= ts) {
			return o;
		}
	}
	return null;
}

/**
 * P2: collapse a run of identical d-pad presses into one goto — but only while the focus
 * actually moved. The guard is the whole value of this pass.
 * @param {Array<object>} presses
 * @param {Array<RecEvent>} obs
 * @param {import('./appprofile.js').AppProfile} profile
 * @return {{steps: Array<object>, warnings: Array<string>, dropped: number}}
 */
function collapseRuns(presses, obs, profile) {
	const steps = [];
	const warnings = [];
	let droppedPresses = 0;
	let i = 0;
	while (i < presses.length) {
		const p = presses[i];
		const isDpad = DPAD_NAMES.indexOf(String(p.name)) >= 0;
		if (!isDpad || p.repeats > 1) {
			steps.push({__press: p, startTs: p.downTs, endTs: p.upTs});
			i++;
			continue;
		}
		let j = i;
		while (j + 1 < presses.length && presses[j + 1].name === p.name && presses[j + 1].repeats === 1) {
			j++;
		}
		const run = presses.slice(i, j + 1);
		if (run.length < 2) {
			steps.push({__press: p, startTs: p.downTs, endTs: p.upTs});
			i = j + 1;
			continue;
		}
		// Did the focus move on EVERY press of the run?
		let moved = 0;
		let prevSig = null;
		const before = obsAfter(obs, run[0].downTs - 1);
		prevSig = before ? before.f : null;
		for (const step of run) {
			const after = obsAfter(obs, step.upTs);
			const sig = after ? after.f : null;
			if (sig !== null && prevSig !== null && sig !== prevSig) {
				moved++;
			}
			prevSig = sig;
		}
		const target = run[run.length - 1];
		const landed = obsAfter(obs, target.upTs);
		if (moved === run.length) {
			steps.push({__goto: {direction: p.name, run: run.length, landed}, startTs: run[0].downTs, endTs: target.upTs});
		} else {
			// The person overshot an edge: the last presses did nothing. Emit only the ones that
			// moved and say so — writing somebody else's overshoot into a case gives you a case
			// that is green for the wrong reason.
			const kept = Math.max(1, moved);
			warnings.push(
				`${run.length}x ${p.name}: focus stopped moving after ${kept} — the last ` +
				`${run.length - kept} press(es) did nothing and were dropped (overshoot at the edge of a list?)`
			);
			droppedPresses += run.length - kept;
			steps.push({
				__goto: {direction: p.name, run: kept, landed, partial: true},
				startTs: run[0].downTs, endTs: run[kept - 1].upTs
			});
		}
		i = j + 1;
	}
	return {steps, warnings, dropped: droppedPresses};
}

/**
 * Name the thing a goto should stop on, best first. A run that cannot be named at all falls
 * back to a press count, with a warning — that case survives nothing.
 * @param {import('./appprofile.js').AppProfile} profile
 * @param {?RecEvent} landed
 * @return {?{target: object, how: string}}
 */
function nameTarget(profile, landed) {
	if (!landed) {
		return null;
	}
	if (landed.fi) {
		return {target: {testid: landed.fi}, how: 'testid'};
	}
	const text = String(landed.fx || '').trim();
	if (text) {
		return {target: {text: text.slice(0, 60)}, how: 'text'};
	}
	return null;
}

/**
 * Which named element (if any) does this focus signature correspond to? Names beat raw
 * selectors in a recorded case for the same reason they beat them in a hand-written one.
 * @param {import('./appprofile.js').AppProfile} profile
 * @param {?RecEvent} landed
 * @return {?string}
 */
function nameElement(profile, landed) {
	if (!landed || !profile.elements) {
		return null;
	}
	const text = String(landed.fx || '').trim().toLowerCase();
	const testid = landed.fi || null;
	for (const name of Object.keys(profile.elements)) {
		const raw = profile.elements[name];
		const spec = typeof raw === 'string' ? {selector: raw} : raw;
		if (spec.testid && testid && spec.testid === testid) {
			return name;
		}
		// A three-character floor: a one-letter text qualifier would match nearly any tile and
		// put the wrong name in the case.
		if (spec.text && text && String(spec.text).length >= 3 &&
			text.indexOf(String(spec.text).toLowerCase()) >= 0) {
			return name;
		}
	}
	return null;
}

/**
 * P3: observations around a step become assertions.
 * @param {?RecEvent} before
 * @param {Array<RecEvent>} obs
 * @param {number} fromTs
 * @param {number} toTs
 * @param {'minimal'|'normal'|'rich'} level
 * @return {Array<object>}
 */
function assertionsFor(before, obs, fromTs, toTs, level) {
	if (level === 'minimal') {
		return [];
	}
	const out = [];
	const window_ = obs.filter((o) => o.ts > fromTs && o.ts <= toTs);
	if (!window_.length) {
		return out;
	}
	const last = window_[window_.length - 1];
	const prevScenes = before ? before.sc : '';
	const prevPopups = before ? before.pp : '';

	if (last.sc && last.sc !== prevScenes) {
		const observedMs = Math.max(0, last.ts - fromTs);
		const timeoutMs = Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, Math.round(observedMs * 3)));
		out.push({wait: {scene: firstSceneToken(last.sc, prevScenes)}, timeoutMs});
	}
	// A popup is scanned across the WHOLE window, not just its last observation: a context menu
	// that opened and was dismissed inside one step would otherwise leave no trace at all, and
	// "it opened" is exactly the thing the case is about.
	let gained = null;
	for (const o of window_) {
		gained = firstNew(o.pp, prevPopups);
		if (gained) {
			break;
		}
	}
	if (gained) {
		out.push({expect: {selector: popupSelectorOf(gained)}, timeoutMs: 5000});
	}
	// Gone is a state, so it is read off the end of the window.
	const lost = firstNew(prevPopups, last.pp);
	if (lost) {
		out.push({expect: {selectorGone: popupSelectorOf(lost)}, timeoutMs: 5000});
	}
	if (level === 'rich') {
		const started = window_.find((o) => o.v && (!before || !before.v));
		const moving = advancing(window_, before);
		if (started || moving) {
			out.push({wait: {videoAdvancing: true}, timeoutMs: WAIT_MAX_MS});
			out.push({videoState: true});
		}
	}
	return out;
}

/**
 * Did playback move between neighbouring observations? Derived host-side, which is why the
 * page-side probe only ever takes ONE sample.
 * @param {Array<RecEvent>} window_
 * @param {?RecEvent} before
 * @return {boolean}
 */
function advancing(window_, before) {
	let prev = before && before.v ? before.v.t : null;
	for (const o of window_) {
		if (!o.v) {
			continue;
		}
		if (prev !== null && o.v.t > prev + 0.05) {
			return true;
		}
		prev = o.v.t;
	}
	return false;
}

/**
 * @param {string} now pipe-joined list
 * @param {string} was pipe-joined list
 * @return {?string} the first entry present in `now` and absent from `was`
 */
function firstNew(now, was) {
	const before = String(was || '').split('|');
	for (const item of String(now || '').split('|')) {
		if (item && before.indexOf(item) < 0) {
			return item;
		}
	}
	return null;
}

/**
 * A scene class string is several tokens; the wait wants the one that is actually new.
 * @param {string} now
 * @param {string} was
 * @return {string}
 */
function firstSceneToken(now, was) {
	const beforeTokens = String(was || '').split(/[\s|]+/).filter(Boolean);
	const nowTokens = String(now || '').split(/[\s|]+/).filter(Boolean);
	for (const t of nowTokens) {
		if (t.length > 2 && beforeTokens.indexOf(t) < 0) {
			return t;
		}
	}
	return nowTokens[0] || String(now || '').slice(0, 40);
}

/**
 * Turn an observed popup className into a selector that will still match tomorrow: the first
 * stable-looking token, as a class selector.
 * @param {string} className
 * @return {string}
 */
function popupSelectorOf(className) {
	const tokens = String(className || '').split(/\s+/).filter((t) => t && t.charAt(0) !== '_');
	return tokens.length ? `.${tokens[0]}` : `[class*="${String(className || '').slice(0, 24)}"]`;
}

/**
 * Compile a timeline into a runnable case body plus the human checklist.
 * @param {Timeline} timeline
 * @param {import('./appprofile.js').AppProfile} profile
 * @param {{platform: string, assert?: 'minimal'|'normal'|'rich', longPressMs?: number,
 *          collapse?: boolean, watch?: Array<object>}} opts
 * @return {{steps: Array<object>, checklist: Array<string>, warnings: Array<string>,
 *           stats: object}}
 */
export function compileCase(timeline, profile, opts) {
	const platform = opts.platform || 'tizen';
	const level = opts.assert || 'normal';
	const longPressMs = opts.longPressMs || DEFAULT_LONG_PRESS_MS;
	const events = timeline.events.slice().sort((a, b) => a.ts - b.ts);
	const obs = events.filter((e) => e.k === 'o');
	const warnings = [];
	const checklist = [];

	const presses = pairKeys(events.filter((e) => e.k === 'd' || e.k === 'u'), platform);
	const collapsed = opts.collapse === false
		? {steps: presses.map((p) => ({__press: p})), warnings: [], dropped: 0}
		: collapseRuns(presses, obs, profile);
	warnings.push(...collapsed.warnings);

	// P6: the case establishes its own precondition.
	const steps = [{launch: {relaunch: true}}];
	let before = obs.length ? obs[0] : null;

	const items = collapsed.steps;
	for (let idx = 0; idx < items.length; idx++) {
		const item = items[idx];
		// The observation window of a step ENDS where the next step begins. Without that cap the
		// windows overlap, and the observations belonging to the next press quietly answer for
		// this one — which is how a popup that opened and then closed reads as "nothing changed".
		const fromTs = item.startTs;
		const nextStart = idx + 1 < items.length ? items[idx + 1].startTs : Infinity;
		const toTs = Math.min(nextStart, item.endTs + 900);
		if (item.__press) {
			const p = item.__press;
			steps.push(classify(p, longPressMs));
			if (p.unreleased) {
				warnings.push(`${p.name} was still held when the recording stopped — emitted as a plain press`);
			}
			if (p.trusted === 0) {
				// Somebody's synthetic press (this MCP's own tv_press) landed in the recording.
				checklist.push(`«${p.name}» пришёл как синтетическое событие (isTrusted=false) — если это была не запись с пульта, шаг лишний`);
			}
			const step = steps[steps.length - 1];
			if (step.longpress) {
				checklist.push(`Лонгтап «${step.longpress}» ${step.durationMs} мс: удержание настоящим пультом отличается от синтетики — проверить на железе`);
			}
		} else {
			const g = item.__goto;
			const named = nameElement(profile, g.landed);
			const raw = nameTarget(profile, g.landed);
			if (named) {
				steps.push({goto: {direction: g.direction, element: named}});
			} else if (raw) {
				steps.push({goto: {direction: g.direction, ...raw.target}});
			} else {
				// Nothing to aim at: fall back to counting presses and say what that costs.
				steps.push({press: g.direction, repeat: g.run});
				warnings.push(
					`${g.run}x ${g.direction}: the focused element had neither a testid nor any text, so this ` +
					'is a press count, not a goto — the case will not survive a markup change'
				);
			}
			if (g.partial) {
				checklist.push(`Ряд «${g.direction}»: часть нажатий не двигала фокус и выброшена — убедиться, что кейс всё ещё про то же место`);
			}
		}
		const asserts = assertionsFor(before, obs, fromTs, toTs, level);
		steps.push(...asserts);
		const lastObs = obs.filter((o) => o.ts <= toTs).pop();
		if (lastObs) {
			before = lastObs;
		}
	}

	// P5: network. The whitelist says what is worth asserting; whether it HAPPENED during this
	// recording is a separate question, and the answer has to come from the log. Asserting a
	// request the scenario never made is fabricating an expectation — the case would be red on
	// its very first replay, for a reason that has nothing to do with the app.
	const watch = opts.watch || [];
	for (const w of watch) {
		steps.push({expectRequest: {urlPattern: w.urlPattern, ...(w.method ? {method: w.method} : {}), timeoutMs: 8000}});
		checklist.push(
			`Сетевой ассерт «${w.name || w.urlPattern}» проверяет только факт запроса. ` +
			'Тело не выводится автоматически: записанное несёт токены и id, такой ассерт зелёный один раз'
		);
	}
	if (watch.length) {
		// The window has to start before the action, or the request has already flown.
		steps.splice(1, 0, {networkMark: true});
	}

	if (timeline.dropped) {
		warnings.push(`${timeline.dropped} event(s) fell out of the page-side ring buffer — the case may be missing steps`);
	}
	if (timeline.reinstalls) {
		warnings.push(
			`the connection dropped ${timeline.reinstalls} time(s) during the recording; events between the ` +
			'drop and the re-install are lost'
		);
	}

	checklist.push('Прогнать на pc-dev-parity прежде чем говорить, что на ТВ будет так же');
	if (platform === 'tizen') {
		checklist.push('На Tizen скриншот виснет (secure plane): кадр видео подтверждает человек, вердикт даёт tv_video_state');
	}

	return {
		steps,
		checklist,
		warnings,
		stats: {
			keys: presses.length,
			observations: obs.length,
			droppedPresses: collapsed.dropped,
			bufferDropped: timeline.dropped,
			reinstalls: timeline.reinstalls
		}
	};
}

/**
 * Render the case as the markdown this repo already runs (cases/README.md), with the steps as
 * a fenced JSON block a human can paste straight into tv_sequence.
 * @param {{title: string, device?: string, steps: Array<object>, checklist: Array<string>,
 *          warnings?: Array<string>, note?: string, durationMs?: number}} c
 * @return {string}
 */
export function renderCase(c) {
	const lines = [];
	lines.push(`# ${c.title}`);
	lines.push('');
	if (c.device) {
		lines.push(`**devices:** ${c.device}`);
	}
	lines.push('**preconditions:** кейс сам приводит приложение в известное состояние первым шагом.');
	lines.push('');
	if (c.note) {
		lines.push(c.note);
		lines.push('');
	}
	lines.push('## Шаги');
	lines.push('');
	lines.push('Записано с пульта' + (c.durationMs ? `, ${Math.round(c.durationMs / 1000)} с` : '') +
		'. Тело кейса — один вызов `tv_sequence`:');
	lines.push('');
	lines.push('```json');
	lines.push(JSON.stringify(c.steps, null, 2));
	lines.push('```');
	lines.push('');
	if (c.warnings && c.warnings.length) {
		lines.push('## Предупреждения компилятора');
		lines.push('');
		for (const w of c.warnings) {
			lines.push(`- ${w}`);
		}
		lines.push('');
	}
	lines.push('## Что подтверждает человек');
	lines.push('');
	for (const item of c.checklist) {
		lines.push(`- [ ] ${item}`);
	}
	lines.push('');
	return lines.join('\n');
}

/**
 * A filesystem-safe basename for a case title.
 * @param {string} title
 * @return {string}
 */
export function slugify(title) {
	const s = String(title || 'recorded-case')
		.toLowerCase()
		.replace(/[^a-z0-9а-яё]+/gi, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return s || 'recorded-case';
}
