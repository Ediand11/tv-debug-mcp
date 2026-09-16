// The page-side half of tv_record: listen to the physical remote, note what changed, and let
// the host drain the buffer.
//
// Why a poll and not a push: `Runtime.addBinding` (the proper page->host channel) is Chrome 51+
// and the park starts at Chrome 38 / WebKit 538. A polled buffer is not a degraded mode here —
// it is the only mode that exists on every engine, so there is exactly one implementation and
// no untested fast path that never runs on a real TV.
//
// Three decisions that are not obvious:
//
//   * capture phase on `window`. That listener runs FIRST in the chain even for an event
//     dispatched straight into `document` — which is how this MCP's own synthetic presses are
//     delivered. So a recording can be exercised with zero TVs involved.
//   * three observations per key, at +30ms, +150ms and +600ms. "Right after", "a frame later"
//     and "settled" are different facts; the press settle already proved focus lands a frame
//     late. The +30 exists because a synthetic press from tv_press settles in ~100ms now, and
//     the next key can arrive before +150 — a popup that opened during a hold and was closed
//     by the very next press would otherwise never be observed. A 1000ms heartbeat catches what
//     the app does on its own.
//   * deduplication by identity. An event is only pushed when something actually changed, so
//     thirty seconds of nobody touching the remote cost ~0 events.
//
// `e.isTrusted` does not exist below Chrome 46 (webOS 3, Tizen 3), so `tr` is 1 / 0 / null and
// is NEVER coerced to a boolean: "the engine cannot tell" and "it was synthetic" are different
// answers, and only one of them is a reason to distrust the recording.
//
// Strict ES5 throughout.

import {stateHelpersJs} from './state.js';

/** Reserved marker for everything this MCP puts in the page — see isOurs() in state.js. */
export const REC_BADGE_CLASS = '__tvdbg-rec';

/** Page-side globals. Named, not anonymous, so a reattach can find and replace them. */
const G = '__tvDebugRec';

/**
 * Install (or re-install) the recorder. Idempotent: calling it again on a page that already
 * has it keeps the buffer and only repairs what is missing, so a navigation or a reattach
 * costs nothing but this call.
 * @param {import('./appprofile.js').AppProfile} profile
 * @param {{cap?: number, heartbeatMs?: number, overlay?: boolean}} opts
 * @return {string}
 */
export function recorderInstallJs(profile, opts) {
	const cap = Math.max(50, Math.floor(opts.cap || 400));
	const heartbeatMs = Math.max(250, Math.floor(opts.heartbeatMs || 1000));
	const overlay = opts.overlay !== false;
	return `(function(){
		${stateHelpersJs(profile)}
		var CAP = ${cap};
		var HEARTBEAT = ${heartbeatMs};
		var OVERLAY = ${overlay ? 'true' : 'false'};

		function videoBrief(){
			// ONE sample. "Advancing" is derived host-side from two neighbouring observations,
			// which is free and works the same for <video> and for the AVPlay object player.
			try {
				var vs = document.getElementsByTagName('video');
				for (var i = 0; i < vs.length; i++) {
					var v = vs[i];
					if (v && (v.currentTime > 0 || v.readyState > 0 || !v.paused)) {
						return {t: Math.round(v.currentTime * 1000) / 1000, p: v.paused ? 1 : 0, r: v.readyState};
					}
				}
				if (window.webapis && window.webapis.avplay && window.webapis.avplay.getState) {
					var st = window.webapis.avplay.getState();
					if (st && st !== 'NONE') {
						var ms = 0;
						try { ms = window.webapis.avplay.getCurrentTime() || 0; } catch (e2) {}
						return {t: Math.round(ms) / 1000, p: st === 'PAUSED' ? 1 : 0, s: st};
					}
				}
			} catch (e) {}
			return null;
		}

		function observe(){
			var f = focusInfo();
			var ps = popupList(3);
			var pc = [];
			for (var i = 0; i < ps.length; i++) { pc.push(ps[i].className); }
			return {
				f: f ? (f.path + '#' + f.index + '/' + f.total + '::' + f.text) : 'NONE',
				fx: f ? f.text : '',
				fi: f ? f.testid : null,
				sc: scenes().join('|'),
				pp: pc.join('|'),
				v: videoBrief()
			};
		}

		var rec = window.${G};
		if (!rec) {
			rec = window.${G} = {
				buf: [], dropped: 0, t0: (new Date()).getTime(), keys: 0, last: null,
				listening: false, timers: [], badge: null
			};
		}
		rec.cap = CAP;

		function push(ev){
			ev.ts = (new Date()).getTime();
			if (rec.buf.length >= rec.cap) { rec.buf.shift(); rec.dropped++; }
			rec.buf.push(ev);
		}
		function snapObs(){
			var o = observe();
			var key = o.f + '§' + o.sc + '§' + o.pp + '§' + (o.v ? (o.v.t + ':' + o.v.p) : '-');
			// Identity dedup: nothing changed -> nothing recorded. Thirty seconds of a person
			// thinking must not cost thirty events.
			if (rec.last === key) { return; }
			rec.last = key;
			o.k = 'o';
			push(o);
		}
		rec.snapObs = snapObs;

		function onDown(e){
			if (!e) { return; }
			var code = e.keyCode || e.which || 0;
			if (!code) { return; }
			rec.keys++;
			push({k: 'd', c: code, rp: e.repeat ? 1 : 0,
				tr: (typeof e.isTrusted === 'boolean') ? (e.isTrusted ? 1 : 0) : null});
		}
		function onUp(e){
			if (!e) { return; }
			var code = e.keyCode || e.which || 0;
			if (!code) { return; }
			push({k: 'u', c: code});
			// Right after, a frame later, and settled.
			rec.timers.push(setTimeout(snapObs, 30));
			rec.timers.push(setTimeout(snapObs, 150));
			rec.timers.push(setTimeout(snapObs, 600));
			if (rec.timers.length > 60) { rec.timers = rec.timers.slice(-30); }
		}
		// Attach ONCE per page. Re-assigning the handlers on every install would leave the
		// previously attached closures in place with nothing able to remove them, and they
		// would keep filling a buffer nobody drains for as long as the page lives.
		if (!rec.listening) {
			rec.onDown = onDown;
			rec.onUp = onUp;
			// Capture on window: first in the chain even for an event dispatched into document,
			// which is how the synthetic presses of this MCP arrive.
			var target = window.addEventListener ? window : document;
			if (target.addEventListener) {
				target.addEventListener('keydown', onDown, true);
				target.addEventListener('keyup', onUp, true);
				rec.listening = true;
				rec.node = target;
				rec.target = target === window ? 'window' : 'document';
			} else if (document.attachEvent) {
				document.attachEvent('onkeydown', onDown);
				document.attachEvent('onkeyup', onUp);
				rec.listening = true;
				rec.node = document;
				rec.target = 'document(attachEvent)';
			}
		}
		if (!rec.hb) {
			rec.hb = setInterval(snapObs, HEARTBEAT);
		}

		if (OVERLAY && (!rec.badge || !rec.badge.parentNode)) {
			// A person holding a remote must be able to SEE that it is recording, otherwise
			// every run starts with a round-trip asking "is it even on?".
			try {
				var b = document.createElement('div');
				b.className = ${JSON.stringify(REC_BADGE_CLASS)};
				b.innerHTML = '\\u25CF REC';
				b.style.cssText = 'position:fixed;top:12px;right:16px;z-index:2147483647;' +
					'background:rgba(190,20,20,.92);color:#fff;font:600 20px/1 sans-serif;' +
					'padding:8px 14px;border-radius:6px;pointer-events:none;';
				(document.body || document.documentElement).appendChild(b);
				rec.badge = b;
			} catch (e) {}
		}

		// Does this engine report isTrusted at all? Probe a real event object rather than
		// guessing from a version string: below Chrome 46 the property simply is not there,
		// and "the engine cannot tell" is a different answer from "it was synthetic".
		var trusted = 0;
		try {
			var probe = document.createEvent('Event');
			probe.initEvent('tvdbgprobe', false, false);
			trusted = (typeof probe.isTrusted === 'boolean') ? 1 : 0;
		} catch (e) {}

		snapObs();
		return {ok: 1, t0: rec.t0, target: rec.target, buffered: rec.buf.length, trusted: trusted};
	})()`;
}

/**
 * Take everything buffered and leave the buffer empty. Returns `{gone:1}` when the recorder is
 * not on the page any more — a navigation blew the global away and the host must re-install.
 * @return {string}
 */
export function recorderDrainJs() {
	return `(function(){
		var rec = window.${G};
		if (!rec) { return {gone: 1}; }
		var out = rec.buf;
		rec.buf = [];
		var d = rec.dropped;
		rec.dropped = 0;
		return {events: out, dropped: d, keys: rec.keys, t0: rec.t0, badge: rec.badge && rec.badge.parentNode ? 1 : 0};
	})()`;
}

/**
 * Remove the listeners, the heartbeat and the badge, and hand back whatever is left.
 * @return {string}
 */
export function recorderStopJs() {
	return `(function(){
		var rec = window.${G};
		if (!rec) { return {gone: 1}; }
		try {
			var target = rec.node || window;
			if (target.removeEventListener) {
				target.removeEventListener('keydown', rec.onDown, true);
				target.removeEventListener('keyup', rec.onUp, true);
			} else if (document.detachEvent) {
				document.detachEvent('onkeydown', rec.onDown);
				document.detachEvent('onkeyup', rec.onUp);
			}
		} catch (e) {}
		if (rec.hb) { try { clearInterval(rec.hb); } catch (e2) {} }
		for (var i = 0; i < rec.timers.length; i++) { try { clearTimeout(rec.timers[i]); } catch (e3) {} }
		if (rec.badge && rec.badge.parentNode) {
			try { rec.badge.parentNode.removeChild(rec.badge); } catch (e4) {}
		}
		var out = rec.buf;
		var d = rec.dropped;
		var keys = rec.keys;
		try { delete window.${G}; } catch (e5) { window.${G} = null; }
		return {events: out, dropped: d, keys: keys};
	})()`;
}

/**
 * Is the recorder still installed? Cheap enough to ask on every status call.
 * @return {string}
 */
export function recorderStatusJs() {
	return `(function(){
		var rec = window.${G};
		if (!rec) { return {gone: 1}; }
		return {buffered: rec.buf.length, dropped: rec.dropped, keys: rec.keys,
			listening: rec.listening ? 1 : 0, badge: rec.badge && rec.badge.parentNode ? 1 : 0};
	})()`;
}
