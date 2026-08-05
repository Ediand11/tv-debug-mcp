// Page-side JavaScript for synthetic key injection and page probes.
//
// EVERYTHING in this file is emitted INTO the TV page, so it must be strict ES5: webOS 3
// runs Chrome 38. No arrow functions, no template literals, no `Array.prototype.find`
// (Chrome 45+), no `Object.assign`. A single ES6 method here means the tool throws a
// TypeError on the oldest device in the park — which is exactly the device we built this
// for. `tv_video_state` had that bug.
//
// Constructing `new KeyboardEvent('keydown', {keyCode})` does NOT populate the legacy
// `keyCode`/`which` fields on any Chromium (they are always 0 from the init dict), and TV
// apps read exactly those. So we build the event, then override keyCode/which — plus the
// modern `key`/`code`, which the Solid stack reads — with Object.defineProperty on the
// instance before dispatching on `document`, the element the app's input layer binds to.
//
// On legacy WebKit (webOS 2, WebKit 538) KeyboardEvent is not constructible at all
// ("KeyboardEventConstructor is not a constructor"), and the two native routes are dead
// ends: a createEvent('KeyboardEvent') instance has keyCode as an unconfigurable 0, and
// initKeyboardEvent's keyIdentifier does not derive keyCode in that build. Meanwhile the
// event MUST pass `instanceof KeyboardEvent` — TV UI frameworks commonly forward a key into
// their child widgets only for KeyboardEvent/WheelEvent instances, so a plain Event
// dispatches fine but navigates nothing. Hence the fallback: a generic Event with the
// overridden fields whose __proto__ is then swapped to KeyboardEvent.prototype — it keeps
// the writable fields, passes instanceof, and the engine dispatches it like any Event.
// Verified on a live webOS 2.2 (LG 40UF771V).

/**
 * Build a page-side expression that dispatches one key event of a given type.
 * @param {'keydown'|'keyup'} type
 * @param {import('./keymaps.js').KeySpec} spec
 * @return {string} a JS expression string for Runtime.evaluate
 */
export function keyEventJs(type, spec) {
	const code = spec.code;
	const key = spec.key || '';
	const domCode = spec.domCode || '';
	return `(function(){
		var e;
		var legacy = false;
		try {
			e = new KeyboardEvent(${JSON.stringify(type)}, {bubbles:true, cancelable:true, view:window});
		} catch (err) {
			legacy = true;
			e = document.createEvent('Event');
			e.initEvent(${JSON.stringify(type)}, true, true);
		}
		function def(name, value){
			try { Object.defineProperty(e, name, {get: function(){ return value; }}); } catch (err) {}
		}
		def('keyCode', ${JSON.stringify(code)});
		def('which', ${JSON.stringify(code)});
		${key ? `def('key', ${JSON.stringify(key)});` : ''}
		${domCode ? `def('code', ${JSON.stringify(domCode)});` : ''}
		if (legacy) {
			try { e.__proto__ = KeyboardEvent.prototype; } catch (err) {}
		}
		document.dispatchEvent(e);
		return true;
	})()`;
}

/** Default focus markers. Some TV frameworks put `_active` on the WHOLE focus chain — scene,
 * container, list, tile — so a plain querySelector returns the scene, not the focused
 * widget. `_focused` is here for the frameworks that use that marker instead. */
export const DEFAULT_FOCUS_SELECTORS = ['._focused', '._active', '.focused', '[data-focused="true"]'];

/**
 * Page-side expression returning a compact snapshot of the currently focused element, so a
 * caller can tell whether a key press moved focus.
 *
 * The element we want is the DEEPEST match — the leaf of the focus chain. Taking the first
 * match returned `NONE` or the scene container on apps that mark the whole chain, which is
 * why `tv_press.focusedAfter` never reported real movement.
 * @param {Array<string>} [focusSelectors] from the app profile
 * @return {string}
 */
export function focusSnapshotJs(focusSelectors) {
	const sel = (focusSelectors && focusSelectors.length ? focusSelectors : DEFAULT_FOCUS_SELECTORS).join(', ');
	return `(function(){
		try{
			var sel = ${JSON.stringify(sel)};
			var all = document.querySelectorAll(sel);
			var f = null;
			for (var i = 0; i < all.length; i++) {
				// a match with no matching descendant is a leaf of the focus chain
				if (!all[i].querySelector(sel)) { f = all[i]; }
			}
			if(!f){ f = document.activeElement; }
			if(!f || f === document.body){ return 'NONE'; }
			var cls = (f.className && f.className.toString ? f.className.toString() : '') || f.tagName;
			var txt = (f.innerText || (f.getAttribute && f.getAttribute('aria-label')) || '').replace(/\\s+/g,' ').trim().slice(0,60);
			return (cls.slice(0,100)) + (txt ? ' :: ' + txt : '');
		}catch(err){ return 'ERR:'+err.message; }
	})()`;
}

/**
 * Page-side helpers for the Tizen object player (`webapis.avplay`).
 *
 * Old Samsung sets have no usable HTML5 `<video>` for adaptive streams: the app plays through
 * `<object type="application/avplayer">` driven by `webapis.avplay`, so every `<video>` probe
 * below finds nothing and reports `{found: 0}` on a TV that is visibly playing. Verified on
 * Tizen 3.0 / Chromium 47 (UE49MU6103).
 *
 * Every call is wrapped: the AVPlay surface differs between firmwares, and a missing getter
 * must cost one field, not the whole probe.
 *
 * Leaves `tvdAv()` (the live player or null) and `tvdAvState(player, t0)` in scope.
 */
const avplayJs = `
	function tvdAvTry(fn, dflt){ try { var v = fn(); return v === undefined ? dflt : v; } catch (err) { return dflt; } }
	function tvdAv(){
		var p = tvdAvTry(function(){ return window.webapis && webapis.avplay; }, null);
		if (!p || typeof p.getState !== 'function') { return null; }
		var st = tvdAvTry(function(){ return p.getState(); }, null);
		// 'NONE' means no player instance was ever opened — the AVPlay equivalent of "no <video>
		// in the DOM". IDLE/READY do count as found: a stream that failed to open sits in IDLE,
		// and reporting that as "no player" would hide exactly the failure worth catching.
		if (!st || st === 'NONE') { return null; }
		return p;
	}
	function tvdAvNum(x){
		// extra_info arrives with STRING values on real firmware ("1280", "2986443") — verified
		// on Tizen 3.0. Numbers must leave this probe as numbers: the <video> branch reports
		// them that way, and a caller comparing bitrate to a threshold would silently compare
		// strings otherwise.
		if (typeof x === 'number') { return isFinite(x) ? x : null; }
		if (typeof x !== 'string' || !x) { return null; }
		var n = parseFloat(x);
		return isFinite(n) ? n : null;
	}
	function tvdAvTime(p){
		var ms = tvdAvNum(tvdAvTry(function(){ return p.getCurrentTime(); }, null));
		return ms === null ? null : ms / 1000;
	}
	function tvdAvVideoInfo(p){
		var out = {};
		var tracks = tvdAvTry(function(){ return p.getCurrentStreamInfo(); }, null);
		if (!tracks || !tracks.length) { return out; }
		for (var i = 0; i < tracks.length; i++) {
			var t = tracks[i];
			if (!t || String(t.type).toUpperCase() !== 'VIDEO') { continue; }
			// extra_info is a JSON STRING on every firmware seen so far; the object form is
			// tolerated in case a newer one stops stringifying it.
			var x = t.extra_info;
			if (typeof x === 'string') { x = tvdAvTry(function(){ return JSON.parse(t.extra_info); }, null); }
			if (!x) { continue; }
			out.codec = x.fourCC || null;
			out.videoWidth = tvdAvNum(x.Width);
			out.videoHeight = tvdAvNum(x.Height);
			out.bitrate = tvdAvNum(x.Bit_rate);
		}
		return out;
	}
	function tvdAvBitrates(p){
		// "957881:1594741:2986443" — the whole ABR ladder the player was given.
		var raw = tvdAvTry(function(){ return p.getStreamingProperty('AVAILABLE_BITRATE'); }, null);
		if (typeof raw !== 'string' || !raw) { return null; }
		var parts = raw.split(':');
		var out = [];
		for (var i = 0; i < parts.length; i++) {
			var n = parseInt(parts[i], 10);
			if (!isNaN(n)) { out.push(n); }
		}
		return out.length ? out : null;
	}
	function tvdAvState(p, t0){
		var st = tvdAvTry(function(){ return p.getState(); }, null);
		var t = tvdAvTime(p);
		var durMs = tvdAvNum(tvdAvTry(function(){ return p.getDuration(); }, null));
		var info = tvdAvVideoInfo(p);
		var moved = (typeof t === 'number' && typeof t0 === 'number') ? +(t - t0).toFixed(3) : null;
		return {
			found: 1,
			// Same field names as the <video> branch — wait.js and tv_sequence read advancing
			// and must not care which player answered — plus what only AVPlay knows.
			source: 'avplay',
			avplayState: st,
			paused: st !== 'PLAYING',
			currentTime: t,
			advancedBy: moved,
			advancing: moved !== null && moved > 0.01,
			duration: (durMs !== null && durMs > 0) ? durMs / 1000 : null,
			videoWidth: info.videoWidth || null,
			videoHeight: info.videoHeight || null,
			codec: info.codec || null,
			bitrate: info.bitrate || null,
			availableBitrates: tvdAvBitrates(p)
		};
	}`;

/**
 * Shared picker: the most likely active player — largest, preferring one that is playing.
 * Leaves `vids` (all candidates) and `v` (the pick, or null) in scope.
 */
const pickVideoJs = `
	var list = document.querySelectorAll('video');
	var vids = [];
	for (var i = 0; i < list.length; i++) { vids.push(list[i]); }
	vids.sort(function(a,b){ return (b.videoWidth*b.videoHeight) - (a.videoWidth*a.videoHeight); });
	var v = null;
	for (var j = 0; j < vids.length; j++) { if (!vids[j].paused) { v = vids[j]; break; } }
	if (!v && vids.length) { v = vids[0]; }`;

/**
 * Page-side expression returning the state of the primary <video> element: whether it is
 * actually advancing (two currentTime samples), readyState, size and error. Falls back to
 * `webapis.avplay` when the page has no <video> at all (old Tizen).
 * @param {number} sampleGapMs
 * @return {string}
 */
export function videoStateJs(sampleGapMs) {
	return `(function(){
		${avplayJs}
		return new Promise(function(resolve){
			${pickVideoJs}
			if(!v){
				var p = tvdAv();
				if (p) {
					var a0 = tvdAvTime(p);
					setTimeout(function(){ resolve(tvdAvState(p, a0)); }, ${Number(sampleGapMs) || 600});
					return;
				}
				resolve({found: vids.length}); return;
			}
			var t0 = v.currentTime;
			setTimeout(function(){
				var errCode = v.error ? v.error.code : null;
				resolve({
					found: vids.length,
					paused: v.paused,
					ended: v.ended,
					currentTime: v.currentTime,
					advancedBy: +(v.currentTime - t0).toFixed(3),
					advancing: (v.currentTime - t0) > 0.01,
					duration: (isFinite(v.duration) ? v.duration : null),
					readyState: v.readyState,
					networkState: v.networkState,
					videoWidth: v.videoWidth,
					videoHeight: v.videoHeight,
					muted: v.muted,
					volume: v.volume,
					playbackRate: v.playbackRate,
					src: (v.currentSrc || v.src || '').slice(0, 200),
					errorCode: errCode
				});
			}, ${Number(sampleGapMs) || 600});
		});
	})()`;
}

/**
 * How long an unclaimed sample slot survives on the page before it deletes itself. Well past
 * any real sample gap — this is leak insurance, not a deadline.
 */
const SAMPLE_SLOT_TTL_MS = 60000;

/**
 * Page-side property name holding one in-flight sample. Keyed per call: the two-call sequence
 * is stateful, and `tv_video_state` takes no lock (it is reachable from inside `tv_sequence`,
 * which already holds the operation lock — taking it again would deadlock). A shared slot
 * would let a second sample overwrite t0 and delete the stash out from under the first.
 * @param {string|number} token
 * @return {string}
 */
function sampleSlot(token) {
	return '__tvDebugVideoSample_' + String(token).replace(/[^A-Za-z0-9_]/g, '');
}

/**
 * Two-call variant of the video sample for engines whose protocol ignores `awaitPromise`
 * (legacy WebKit, webOS 2): the promise-based expression above would come back as an
 * unresolved, empty object there. This one stashes the picked <video> and its currentTime
 * on the page; the finish expression reads the SAME element back — two independent picks
 * could land on different elements mid-transition.
 * @return {string}
 */
export function videoSampleStartJs(token) {
	const slot = JSON.stringify(sampleSlot(token));
	return `(function(){
		${avplayJs}
		${pickVideoJs}
		if(!v){
			// No <video>: the object player is the only thing that can be playing here. Only the
			// timestamp is stashed — AVPlay is a singleton, so there is no element to pin.
			var p = tvdAv();
			if (!p) { return {found: vids.length}; }
			window[${slot}] = {av: 1, t0: tvdAvTime(p), n: 1};
			setTimeout(function(){ try { delete window[${slot}]; } catch (err) {} }, ${SAMPLE_SLOT_TTL_MS});
			return {found: 1};
		}
		window[${slot}] = {v: v, t0: v.currentTime, n: vids.length};
		// Self-expiring: if the finish never runs (eval error, socket drop, timeout) the
		// stashed <video> would stay strongly reachable from window and show up as a false
		// retainer in a tv_heap diff. Only this call's own slot is touched, so a concurrent
		// sample is never swept out from under itself.
		setTimeout(function(){ try { delete window[${slot}]; } catch (err) {} }, ${SAMPLE_SLOT_TTL_MS});
		return {found: vids.length};
	})()`;
}

/**
 * @param {string|number} token must match the one given to videoSampleStartJs
 * @return {string}
 */
export function videoSampleFinishJs(token) {
	const slot = JSON.stringify(sampleSlot(token));
	return `(function(){
		${avplayJs}
		var s = window[${slot}];
		delete window[${slot}];
		// The stash is gone: the page navigated during the gap, the context was recreated, or
		// a concurrent sample consumed it. Say so — a caller that stamped a count over this
		// would turn a lost sample into a confident "not advancing".
		if(!s){ return {found: 0, sampleLost: true}; }
		if (s.av) {
			var p = tvdAv();
			// The player was torn down between the samples: no verdict, and saying "not
			// advancing" here would read as a playback failure that did not happen.
			if (!p) { return {found: 0, sampleLost: true}; }
			return tvdAvState(p, s.t0);
		}
		var v = s.v;
		var errCode = v.error ? v.error.code : null;
		return {
			found: s.n,
			paused: v.paused,
			ended: v.ended,
			currentTime: v.currentTime,
			advancedBy: +(v.currentTime - s.t0).toFixed(3),
			advancing: (v.currentTime - s.t0) > 0.01,
			duration: (isFinite(v.duration) ? v.duration : null),
			readyState: v.readyState,
			networkState: v.networkState,
			videoWidth: v.videoWidth,
			videoHeight: v.videoHeight,
			muted: v.muted,
			volume: v.volume,
			playbackRate: v.playbackRate,
			src: (v.currentSrc || v.src || '').slice(0, 200),
			errorCode: errCode
		};
	})()`;
}
