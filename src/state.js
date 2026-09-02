// One structured page-side snapshot: where we are, what has focus, what is on top.
//
// Strict ES5 (webOS 3 is Chrome 38): no arrow functions, no `Element.closest`
// (Chrome 41+), no `Array.prototype.find` (Chrome 45+), no template literals.
//
// The focused widget is the DEEPEST element matching the profile's focus selectors:
// a framework may mark the whole chain scene > container > list > tile with `_active`, so
// the first match is the scene and tells you nothing about navigation.
//
// The helpers are installed on the page ONCE (`window.__tvdbg`, see helpersInstallJs) and
// every snippet built here is a ~300-byte call into them (withHelpersJs). Sending the 4.5 KB
// preamble with every poll made the engine re-parse it on each of the 4-10 round-trips a
// single navigation step costs. The install self-expires like every other page-side stash of
// this MCP (PAGE_SLOT_TTL_MS): it holds no DOM references, but a global that never goes away
// is a false lead in a tv_heap diff either way.

/** Same lifetime as every other page-side slot — kept here to avoid an import cycle. */
const HELPERS_TTL_MS = 60000;

/**
 * Shared ES5 preamble: helpers every generated snippet uses.
 * @param {import('./appprofile.js').AppProfile} profile
 * @return {string}
 */
export function stateHelpersJs(profile) {
	const focusSel = profile.focus.join(', ');
	const sceneSel = profile.scene.container;
	const strip = profile.scene.strip || '';
	const popupSel = profile.popup.join(', ');
	return `
		var FOCUS_SEL = ${JSON.stringify(focusSel)};
		var SCENE_SEL = ${JSON.stringify(sceneSel)};
		var STRIP = ${JSON.stringify(strip)};
		var POPUP_SEL = ${JSON.stringify(popupSel)};
		// Anything this MCP itself puts on the page (the recorder's REC badge) is marked with
		// a reserved __tvdbg prefix and must never show up as app structure — it would land in
		// popup scans, in snapshot rows, and in the recorder's own change detection.
		function isOurs(el){
			return !!(el && el.className && String(el.className).indexOf('__tvdbg') >= 0);
		}
		function matchesSel(el, sel){
			if (!el || el.nodeType !== 1) { return false; }
			var fn = el.matches || el.webkitMatchesSelector || el.msMatchesSelector;
			try { return fn ? fn.call(el, sel) : false; } catch (e) { return false; }
		}
		function closestSel(el, sel){
			var n = el;
			while (n && n.nodeType === 1) {
				if (matchesSel(n, sel)) { return n; }
				n = n.parentNode;
			}
			return null;
		}
		function visible(el){
			if (!el) { return false; }
			var s;
			try { s = getComputedStyle(el); } catch (e) { return false; }
			return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetHeight > 0;
		}
		function txt(el, n){
			if (!el) { return ''; }
			var t = el.innerText || (el.getAttribute && el.getAttribute('aria-label')) || '';
			return String(t).replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '').slice(0, n || 80);
		}
		// textContent, not innerText: innerText forces a layout flush on every read, and a
		// signature that is only compared for equality does not need visible-text semantics.
		function rawTxt(el, n){
			if (!el) { return ''; }
			var t = el.textContent || (el.getAttribute && el.getAttribute('aria-label')) || '';
			return String(t).replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '').slice(0, n || 60);
		}
		function cls(el){
			return el && el.className && el.className.toString ? el.className.toString() : (el ? el.tagName : '');
		}
		function firstToken(el){
			var c = cls(el).split(' ');
			for (var i = 0; i < c.length; i++) { if (c[i] && c[i].charAt(0) !== '_') { return c[i]; } }
			return el ? el.tagName : '';
		}
		function focusLeaf(){
			var all = document.querySelectorAll(FOCUS_SEL);
			var f = null;
			for (var i = 0; i < all.length; i++) {
				if (!all[i].querySelector(FOCUS_SEL)) { f = all[i]; }
			}
			return f;
		}
		function focusPos(f){
			var parent = f.parentNode;
			var token = firstToken(f);
			var index = -1, total = 0;
			if (parent && parent.children) {
				for (var i = 0; i < parent.children.length; i++) {
					var sib = parent.children[i];
					if (firstToken(sib) === token) {
						if (sib === f) { index = total; }
						total++;
					}
				}
			}
			var path = [];
			var n = f;
			for (var d = 0; d < 3 && n && n.nodeType === 1; d++) { path.unshift(firstToken(n)); n = n.parentNode; }
			return {path: path.join(' > '), index: index, total: total};
		}
		function focusInfo(){
			var f = focusLeaf();
			if (!f) { return null; }
			var pos = focusPos(f);
			return {
				text: txt(f, 90),
				className: cls(f).slice(0, 140),
				tag: f.tagName,
				testid: (f.getAttribute && (f.getAttribute('data-testid') || f.getAttribute('data-export-id'))) || null,
				path: pos.path,
				index: pos.index,
				total: pos.total,
				visible: visible(f)
			};
		}
		// Compact focus signature: "did the press land", "are we looping". Cheap on purpose —
		// it is what every settle poll reads.
		function focusSig(){
			var f = focusLeaf();
			if (!f) { return 'NONE'; }
			var pos = focusPos(f);
			return pos.path + '#' + pos.index + '/' + pos.total + '::' + rawTxt(f, 60);
		}
		function scenes(){
			var out = [];
			var list = document.querySelectorAll(SCENE_SEL);
			for (var i = 0; i < list.length; i++) {
				if (!visible(list[i])) { continue; }
				var c = cls(list[i]);
				if (STRIP) { c = c.replace(new RegExp(STRIP, 'g'), ''); }
				c = c.replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '');
				if (c) { out.push(c.slice(0, 60)); }
			}
			return out;
		}
		function popupList(max){
			var out = [];
			var cap = max || 5;
			var plist = document.querySelectorAll(POPUP_SEL);
			for (var i = 0; i < plist.length && out.length < cap; i++) {
				if (isOurs(plist[i]) || !visible(plist[i])) { continue; }
				out.push({className: cls(plist[i]).slice(0, 90), text: txt(plist[i], 120)});
			}
			return out;
		}
		function rectOf(el){
			if (!el || !el.getBoundingClientRect) { return null; }
			var r;
			try { r = el.getBoundingClientRect(); } catch (e) { return null; }
			return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)};
		}
		// On a 40-row catalog this is the single filter that decides whether the answer costs
		// 1.5 KB or 40 KB: what is off-screen is not what the next press is about.
		function inViewport(el, pad){
			var r = rectOf(el);
			if (!r || r.w <= 0 || r.h <= 0) { return false; }
			var vw = window.innerWidth || document.documentElement.clientWidth || 0;
			var vh = window.innerHeight || document.documentElement.clientHeight || 0;
			var p = pad || 0;
			return r.x < vw + p && r.y < vh + p && (r.x + r.w) > -p && (r.y + r.h) > -p;
		}
		function containsEl(root, el){
			var n = el;
			while (n) {
				if (n === root) { return true; }
				n = n.parentNode;
			}
			return false;
		}
	`;
}

/** Names exported by the preamble, in the order the alias line lists them. */
const HELPER_NAMES = [
	'FOCUS_SEL', 'SCENE_SEL', 'STRIP', 'POPUP_SEL',
	'isOurs', 'matchesSel', 'closestSel', 'visible', 'txt', 'rawTxt', 'cls', 'firstToken',
	'focusLeaf', 'focusPos', 'focusInfo', 'focusSig', 'scenes', 'popupList', 'rectOf', 'inViewport', 'containsEl'
];

/**
 * Identity of an installed helper set. Changes with the profile's selectors, so an app
 * profile edited between calls reinstalls instead of running yesterday's selectors.
 * @param {import('./appprofile.js').AppProfile} profile
 * @return {string}
 */
export function helpersKey(profile) {
	const src = JSON.stringify([profile.id, profile.focus, profile.scene, profile.popup]);
	// djb2 — a short stable tag is all this needs.
	let h = 5381;
	for (let i = 0; i < src.length; i++) {
		h = ((h * 33) ^ src.charCodeAt(i)) >>> 0;
	}
	return 'h' + h.toString(36);
}

/**
 * Install (or replace) the helper set on the page. One evaluate per connection and per
 * navigation; every snippet afterwards is a call into it.
 * @param {import('./appprofile.js').AppProfile} profile
 * @return {string}
 */
export function helpersInstallJs(profile) {
	const key = JSON.stringify(helpersKey(profile));
	return `(function(){
		${stateHelpersJs(profile)}
		var H = {v: ${key}, t: null};
		${HELPER_NAMES.map((n) => `H.${n} = ${n};`).join('\n\t\t')}
		// Self-expiring, refreshed on every use: idle for a minute and the install is gone,
		// exactly like the snapshot ref store and the video sample slots.
		H.touch = function(){
			if (H.t) { try { clearTimeout(H.t); } catch (e) {} }
			H.t = setTimeout(function(){
				if (window.__tvdbg === H) { try { delete window.__tvdbg; } catch (e) { window.__tvdbg = null; } }
			}, ${HELPERS_TTL_MS});
		};
		window.__tvdbg = H;
		H.touch();
		return {installed: 1};
	})()`;
}

/**
 * Wrap a snippet body so it runs against the installed helpers. When the install is missing
 * or belongs to another profile the call answers `{__tvdbgMissing: 1}` and the host installs
 * and retries (DeviceSession._pageCall) — one extra round-trip per navigation, not per call.
 * @param {import('./appprofile.js').AppProfile} profile
 * @param {string} body ES5 statements; may `return`
 * @return {string}
 */
export function withHelpersJs(profile, body) {
	const key = JSON.stringify(helpersKey(profile));
	return `(function(){
		var H = window.__tvdbg;
		if (!H || H.v !== ${key}) { return {__tvdbgMissing: 1}; }
		H.touch();
		var ${HELPER_NAMES.map((n) => `${n} = H.${n}`).join(', ')};
		${body}
	})()`;
}

/**
 * Full snapshot expression.
 * @param {import('./appprofile.js').AppProfile} profile
 * @param {{withSig?: boolean}} [opts] withSig adds the focus signature — what tv_menu needs
 *   alongside the state to open the menu without a second round-trip
 * @return {string}
 */
export function stateJs(profile, opts = {}) {
	const menu = profile.menu;
	return withHelpersJs(profile, `
		var popups = popupList(5);
		var f = focusInfo();
		var inMenu = false;
		${menu ? `
		var leaf = focusLeaf();
		inMenu = !!(leaf && closestSel(leaf, ${JSON.stringify(menu.root)}));
		` : ''}
		return {
			url: location.href,
			title: document.title,
			scenes: scenes(),
			focus: f,
			focusInMenu: inMenu,
			popups: popups,
			counts: {
				tiles: ${profile.tile ? `document.querySelectorAll(${JSON.stringify(profile.tile)}).length` : '0'},
				menuItems: ${menu ? `document.querySelectorAll(${JSON.stringify(menu.item)}).length` : '0'},
				popups: popups.length
			}${opts.withSig ? ',\n\t\t\tsig: focusSig()' : ''}
		};`);
}

/**
 * Compact focus signature used to detect "did the press land" and "are we looping".
 * @param {import('./appprofile.js').AppProfile} profile
 * @return {string}
 */
export function focusSignatureJs(profile) {
	return withHelpersJs(profile, 'return focusSig();');
}

/**
 * Body of the "does the FOCUSED element match this target" check. `tv_goto` must check the
 * focused element itself: "a matching selector exists on the page" is true while focus sits
 * somewhere else entirely. Returns statements ending in `return {ok, detail}`, so the same
 * check can run inline at the end of a press settle (inject.js pressJs).
 * @param {{text?: string, selector?: string, testid?: string}} target
 * @return {string}
 */
export function focusMatchesBody(target) {
	return `
		var f = focusLeaf();
		if (!f) { return {ok: false, detail: 'no focus'}; }
		var ok = true;
		${target.text != null ? `ok = ok && txt(f, 200).toLowerCase().indexOf(${JSON.stringify(String(target.text).toLowerCase())}) >= 0;` : ''}
		${target.selector != null ? `ok = ok && matchesSel(f, ${JSON.stringify(target.selector)});` : ''}
		${target.testid != null ? `ok = ok && ((f.getAttribute && (f.getAttribute('data-testid') || f.getAttribute('data-export-id'))) === ${JSON.stringify(target.testid)});` : ''}
		return {ok: ok, detail: focusInfo()};`;
}

/**
 * @param {import('./appprofile.js').AppProfile} profile
 * @param {{text?: string, selector?: string, testid?: string}} target
 * @return {string}
 */
export function focusMatchesJs(profile, target) {
	return withHelpersJs(profile, focusMatchesBody(target));
}

/**
 * Body of "is the focus inside the menu" — what tv_menu checks after every opening press.
 * @param {{root: string}} menu
 * @return {string}
 */
export function focusInMenuBody(menu) {
	return `
		var leaf = focusLeaf();
		return {ok: !!(leaf && closestSel(leaf, ${JSON.stringify(menu.root)})), detail: focusInfo()};`;
}

/**
 * One call that answers both "are we already on the target" and "where is the focus" — the
 * opening read of tv_goto.
 * @param {import('./appprofile.js').AppProfile} profile
 * @param {string} matchBody from focusMatchesBody / focusIsRefBody
 * @return {string}
 */
export function sigAndMatchJs(profile, matchBody) {
	return withHelpersJs(profile, `
		var match = (function(){ ${matchBody} })();
		return {sig: focusSig(), match: match};`);
}

/**
 * Titles of the app's menu items, in order — so `tv_menu` can report what it could have
 * chosen when a name does not match.
 * @param {import('./appprofile.js').AppProfile} profile
 * @return {string}
 */
export function menuItemsJs(profile) {
	const menu = profile.menu;
	return withHelpersJs(profile, `
		var out = [];
		var items = document.querySelectorAll(${JSON.stringify(menu.item)});
		for (var i = 0; i < items.length; i++) {
			if (!visible(items[i])) { continue; }
			out.push(txt(${menu.title ? `items[i].querySelector(${JSON.stringify(menu.title)}) || items[i]` : 'items[i]'}, 40));
		}
		return out;`);
}
