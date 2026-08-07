// One structured page-side snapshot: where we are, what has focus, what is on top.
//
// Strict ES5 (webOS 3 is Chrome 38): no arrow functions, no `Element.closest`
// (Chrome 41+), no `Array.prototype.find` (Chrome 45+), no template literals.
//
// The focused widget is the DEEPEST element matching the profile's focus selectors:
// a framework may mark the whole chain scene > container > list > tile with `_active`, so
// the first match is the scene and tells you nothing about navigation.

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
		function focusInfo(){
			var f = focusLeaf();
			if (!f) { return null; }
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
			return {
				text: txt(f, 90),
				className: cls(f).slice(0, 140),
				tag: f.tagName,
				testid: (f.getAttribute && (f.getAttribute('data-testid') || f.getAttribute('data-export-id'))) || null,
				path: path.join(' > '),
				index: index,
				total: total,
				visible: visible(f)
			};
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

/**
 * Full snapshot expression.
 * @param {import('./appprofile.js').AppProfile} profile
 * @return {string}
 */
export function stateJs(profile) {
	const menu = profile.menu;
	return `(function(){
		${stateHelpersJs(profile)}
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
			}
		};
	})()`;
}

/**
 * Compact focus signature used to detect "did the press land" and "are we looping".
 * @param {import('./appprofile.js').AppProfile} profile
 * @return {string}
 */
export function focusSignatureJs(profile) {
	return `(function(){
		${stateHelpersJs(profile)}
		var f = focusInfo();
		if (!f) { return 'NONE'; }
		return f.path + '#' + f.index + '/' + f.total + '::' + f.text;
	})()`;
}

/**
 * Does the FOCUSED element match a target? `tv_goto` must check the focused element itself:
 * "a matching selector exists on the page" is true while focus sits somewhere else entirely.
 * @param {import('./appprofile.js').AppProfile} profile
 * @param {{text?: string, selector?: string, testid?: string}} target
 * @return {string}
 */
export function focusMatchesJs(profile, target) {
	return `(function(){
		${stateHelpersJs(profile)}
		var f = focusLeaf();
		if (!f) { return {ok: false, detail: 'no focus'}; }
		var info = focusInfo();
		var ok = true;
		${target.text != null ? `ok = ok && txt(f, 200).toLowerCase().indexOf(${JSON.stringify(String(target.text).toLowerCase())}) >= 0;` : ''}
		${target.selector != null ? `ok = ok && matchesSel(f, ${JSON.stringify(target.selector)});` : ''}
		${target.testid != null ? `ok = ok && ((f.getAttribute && (f.getAttribute('data-testid') || f.getAttribute('data-export-id'))) === ${JSON.stringify(target.testid)});` : ''}
		return {ok: ok, detail: info};
	})()`;
}

/**
 * Titles of the app's menu items, in order — so `tv_menu` can report what it could have
 * chosen when a name does not match.
 * @param {import('./appprofile.js').AppProfile} profile
 * @return {string}
 */
export function menuItemsJs(profile) {
	const menu = profile.menu;
	return `(function(){
		${stateHelpersJs(profile)}
		var out = [];
		var items = document.querySelectorAll(${JSON.stringify(menu.item)});
		for (var i = 0; i < items.length; i++) {
			if (!visible(items[i])) { continue; }
			out.push(txt(${menu.title ? `items[i].querySelector(${JSON.stringify(menu.title)}) || items[i]` : 'items[i]'}, 40));
		}
		return out;
	})()`;
}
