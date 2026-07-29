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
		var e = new KeyboardEvent(${JSON.stringify(type)}, {bubbles:true, cancelable:true, view:window});
		function def(name, value){
			try { Object.defineProperty(e, name, {get: function(){ return value; }}); } catch (err) {}
		}
		def('keyCode', ${JSON.stringify(code)});
		def('which', ${JSON.stringify(code)});
		${key ? `def('key', ${JSON.stringify(key)});` : ''}
		${domCode ? `def('code', ${JSON.stringify(domCode)});` : ''}
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
 * Page-side expression returning the state of the primary <video> element: whether it is
 * actually advancing (two currentTime samples), readyState, size and error.
 * @param {number} sampleGapMs
 * @return {string}
 */
export function videoStateJs(sampleGapMs) {
	return `(function(){
		return new Promise(function(resolve){
			var list = document.querySelectorAll('video');
			var vids = [];
			for (var i = 0; i < list.length; i++) { vids.push(list[i]); }
			if(!vids.length){ resolve({found:0}); return; }
			// pick the most likely active player: largest, preferring one that is playing
			vids.sort(function(a,b){ return (b.videoWidth*b.videoHeight) - (a.videoWidth*a.videoHeight); });
			var v = null;
			for (var j = 0; j < vids.length; j++) { if (!vids[j].paused) { v = vids[j]; break; } }
			if (!v) { v = vids[0]; }
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
