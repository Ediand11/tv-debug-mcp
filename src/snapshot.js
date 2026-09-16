// One round-trip that says enough to plan three to five moves, instead of press-look-press-look.
//
// The problem it solves: an agent driving a TV app does not know the layout. Today it presses
// a direction, reads tv_state, presses again — every answer lands in the context window and
// every move is a guess. A snapshot returns the rows around the focus, so the next moves are
// arithmetic rather than probing.
//
// Two tiers of rows, and the answer says which one produced them:
//   * profile — apps/<id>.json `snapshot.row` / `snapshot.item` (or `tile` / `menu.item`).
//     Precise, and the rows can carry labels.
//   * generic — no app knowledge at all: the focus row is exactly what focusInfo() already
//     computes (siblings sharing the focused element's first class token), and the neighbouring
//     rows are the container's siblings that hold the same kind of element.
// Neither yielded anything -> `rows: []` plus a warning naming the fix. Structure is never
// invented; a made-up row is worse than no row, because the agent will navigate by it.
//
// Compactness levers, in the order they matter: the viewport filter (on a 40-row catalog it
// decides everything), maxRows/maxItemsPerRow with a `more` count, text cut to 32 chars, and
// an item that carries {ref, i, t} and nothing else — no className, no path, no rect.
//
// Strict ES5, like every page-side builder here (webOS 3 is Chrome 38).

import {withHelpersJs} from './state.js';

/** Refs are handed out as e1, e2, … and NEVER reused across snapshots — see refStoreJs. */
export const REF_PREFIX = 'e';

/**
 * The ref store lives on `window.__tvDebugSnap`. Two properties of it are deliberate:
 *
 *   * the previous generation's map is DROPPED on every snapshot, and the whole store expires
 *     on a timer. A map of live Elements hanging off `window` is a false retainer in a
 *     tv_heap diff, and this repo has already chased one of those.
 *   * ref numbers are monotonic across generations, so a stale ref can never silently resolve
 *     to a different element that happens to sit in the same slot. That is the entire reason
 *     the numbering is global rather than per-snapshot.
 *
 * @param {number} ttlMs
 * @return {string} ES5 statements defining `snapRef(el)` and finalising the store
 */
function refStoreJs(ttlMs) {
	return `
		var __prev = window.__tvDebugSnap;
		if (__prev && __prev.timer) { try { clearTimeout(__prev.timer); } catch (e) {} }
		var __g = __prev && __prev.g ? __prev.g + 1 : 1;
		var __next = __prev && __prev.next ? __prev.next : 1;
		var __min = __next;
		var __refs = {};
		function snapRef(el){
			var k = ${JSON.stringify(REF_PREFIX)} + __next;
			__next++;
			__refs[k] = el;
			return k;
		}
		function snapCommit(){
			window.__tvDebugSnap = {
				g: __g, refs: __refs, min: __min, next: __next,
				timer: setTimeout(function(){ try { delete window.__tvDebugSnap; } catch (e) {} }, ${ttlMs})
			};
		}
	`;
}

/**
 * @param {import('./appprofile.js').AppProfile} profile
 * @return {{row: string, item: string, label: string}} selectors of the profile tier ('' when absent)
 */
function snapshotSelectors(profile) {
	const snap = profile.snapshot || {};
	const item = snap.item || [profile.tile, profile.menu && profile.menu.item].filter(Boolean).join(', ');
	return {
		row: snap.row || '',
		item: item || '',
		label: snap.label || ''
	};
}

/**
 * Build the snapshot expression.
 * @param {import('./appprofile.js').AppProfile} profile
 * @param {{detail?: 'focus'|'rows'|'full', maxRows?: number, maxItemsPerRow?: number,
 *          textMax?: number, ttlMs: number}} opts
 * @return {string}
 */
export function snapshotJs(profile, opts) {
	const sel = snapshotSelectors(profile);
	const snap = profile.snapshot || {};
	const detail = opts.detail || 'rows';
	const maxRows = Math.max(1, Math.floor(opts.maxRows || snap.maxRows || 6));
	const maxItems = Math.max(1, Math.floor(opts.maxItemsPerRow || snap.maxItemsPerRow || 12));
	const textMax = Math.max(8, Math.floor(opts.textMax || 32));

	return withHelpersJs(profile, `
		${refStoreJs(opts.ttlMs)}
		var DETAIL = ${JSON.stringify(detail)};
		var ROW_SEL = ${JSON.stringify(sel.row)};
		var ITEM_SEL = ${JSON.stringify(sel.item)};
		var LABEL_SEL = ${JSON.stringify(sel.label)};
		var MAX_ROWS = ${maxRows};
		var MAX_ITEMS = ${maxItems};
		var TEXT_MAX = ${textMax};
		var VIEWPORT_ONLY = DETAIL !== 'full';

		var focusEl = focusLeaf();
		var out = {
			g: __g,
			url: location.href,
			scenes: scenes(),
			popups: popupList(5),
			focus: focusInfo(),
			tier: null,
			rows: [],
			counts: {}
		};

		if (DETAIL === 'focus') {
			if (focusEl && out.focus) { out.focus.ref = snapRef(focusEl); }
			out.counts = {rows: 0, items: 0, popups: out.popups.length};
			snapCommit();
			return out;
		}

		function indexOfEl(list, el){
			for (var i = 0; i < list.length; i++) { if (list[i] === el) { return i; } }
			return -1;
		}
		function itemsUnder(rowEl){
			var out2 = [];
			var list = rowEl.querySelectorAll(ITEM_SEL);
			for (var i = 0; i < list.length; i++) {
				if (!isOurs(list[i])) { out2.push(list[i]); }
			}
			return out2;
		}

		// --- tier 1: the app profile knows the layout ------------------------------------
		var rows = [];
		if (ITEM_SEL) {
			if (ROW_SEL) {
				var rl = document.querySelectorAll(ROW_SEL);
				for (var i = 0; i < rl.length; i++) {
					if (isOurs(rl[i]) || !visible(rl[i])) { continue; }
					var its = itemsUnder(rl[i]);
					if (its.length) { rows.push({el: rl[i], items: its}); }
				}
			} else {
				// No row selector: the items' own parents ARE the rows. Grouping beats guessing
				// a container selector we were never told about.
				var all = document.querySelectorAll(ITEM_SEL);
				var parents = [], buckets = [];
				for (var i = 0; i < all.length; i++) {
					if (isOurs(all[i]) || !visible(all[i])) { continue; }
					var p = all[i].parentNode;
					var idx = -1;
					for (var j = 0; j < parents.length; j++) { if (parents[j] === p) { idx = j; break; } }
					if (idx < 0) { parents.push(p); buckets.push([]); idx = parents.length - 1; }
					buckets[idx].push(all[i]);
				}
				for (var j = 0; j < parents.length; j++) { rows.push({el: parents[j], items: buckets[j]}); }
			}
			if (rows.length) { out.tier = 'profile'; }
		}

		// --- tier 2: no app knowledge at all ---------------------------------------------
		if (!rows.length && focusEl) {
			var token = firstToken(focusEl);
			var container = focusEl.parentNode;
			var sibs = (container && container.parentNode && container.parentNode.children)
				? container.parentNode.children
				: [container];
			for (var i = 0; i < sibs.length; i++) {
				var s = sibs[i];
				if (!s || s.nodeType !== 1 || isOurs(s) || !visible(s) || !s.children) { continue; }
				var its2 = [];
				for (var k = 0; k < s.children.length; k++) {
					if (firstToken(s.children[k]) === token) { its2.push(s.children[k]); }
				}
				if (its2.length) { rows.push({el: s, items: its2}); }
			}
			if (rows.length) { out.tier = 'generic'; }
		}

		// --- viewport filter, then caps centred on the focus -------------------------------
		var kept = [], droppedRows = 0, focusRow = -1;
		for (var i = 0; i < rows.length; i++) {
			var hasFocus = !!(focusEl && containsEl(rows[i].el, focusEl));
			if (VIEWPORT_ONLY && !hasFocus && !inViewport(rows[i].el)) { droppedRows++; continue; }
			if (hasFocus) { focusRow = kept.length; }
			kept.push(rows[i]);
		}
		if (kept.length > MAX_ROWS) {
			var start = focusRow < 0 ? 0 : focusRow - Math.floor(MAX_ROWS / 2);
			if (start < 0) { start = 0; }
			if (start > kept.length - MAX_ROWS) { start = kept.length - MAX_ROWS; }
			droppedRows += kept.length - MAX_ROWS;
			if (focusRow >= 0) { focusRow = focusRow - start; }
			kept = kept.slice(start, start + MAX_ROWS);
		}

		var collected = [];
		for (var i = 0; i < kept.length; i++) {
			var items = kept[i].items;
			var vis = [], more = 0;
			for (var j = 0; j < items.length; j++) {
				if (VIEWPORT_ONLY && items[j] !== focusEl && !inViewport(items[j])) { more++; continue; }
				vis.push(items[j]);
			}
			if (vis.length > MAX_ITEMS) {
				var fi = indexOfEl(vis, focusEl);
				var s2 = fi < 0 ? 0 : fi - Math.floor(MAX_ITEMS / 2);
				if (s2 < 0) { s2 = 0; }
				if (s2 > vis.length - MAX_ITEMS) { s2 = vis.length - MAX_ITEMS; }
				more += vis.length - MAX_ITEMS;
				vis = vis.slice(s2, s2 + MAX_ITEMS);
			}
			var jsonItems = [];
			for (var j = 0; j < vis.length; j++) {
				var r = {ref: snapRef(vis[j]), i: indexOfEl(items, vis[j]), t: txt(vis[j], TEXT_MAX)};
				if (vis[j] === focusEl) { r.focused = true; }
				jsonItems.push(r);
				collected.push({el: vis[j], ref: r.ref});
			}
			var row = {i: i, items: jsonItems};
			if (more > 0) { row.more = more; }
			if (i === focusRow) { row.focused = true; }
			if (LABEL_SEL) {
				var lab = kept[i].el.querySelector(LABEL_SEL);
				if (lab) { row.label = txt(lab, 40); }
			}
			out.rows.push(row);
		}
		if (droppedRows > 0) { out.moreRows = droppedRows; }

		// --- neighbours: LAYOUT GEOMETRY, not the app's navigation graph -------------------
		// Nearest centre in each direction among the elements above. It proves a tv_goto {ref}
		// move is one press away; it does NOT know what the app does on that press.
		if (focusEl) {
			var fr = rectOf(focusEl);
			if (fr) {
				var fx = fr.x + fr.w / 2, fy = fr.y + fr.h / 2;
				var best = {LEFT: null, RIGHT: null, UP: null, DOWN: null};
				var score = {LEFT: 0, RIGHT: 0, UP: 0, DOWN: 0};
				for (var i = 0; i < collected.length; i++) {
					if (collected[i].el === focusEl) { continue; }
					var cr = rectOf(collected[i].el);
					if (!cr) { continue; }
					var dx = (cr.x + cr.w / 2) - fx;
					var dy = (cr.y + cr.h / 2) - fy;
					var dirs = [
						['RIGHT', dx > 4, dx, dy < 0 ? -dy : dy],
						['LEFT', dx < -4, -dx, dy < 0 ? -dy : dy],
						['DOWN', dy > 4, dy, dx < 0 ? -dx : dx],
						['UP', dy < -4, -dy, dx < 0 ? -dx : dx]
					];
					for (var d = 0; d < dirs.length; d++) {
						if (!dirs[d][1]) { continue; }
						var sc = dirs[d][2] + 2 * dirs[d][3];
						if (best[dirs[d][0]] === null || sc < score[dirs[d][0]]) {
							best[dirs[d][0]] = collected[i].ref;
							score[dirs[d][0]] = sc;
						}
					}
				}
				out.neighbours = best;
			}
		}

		if (out.focus && focusEl) {
			var known = -1;
			for (var i = 0; i < collected.length; i++) {
				if (collected[i].el === focusEl) { known = i; break; }
			}
			// The focus always gets a ref, even when it is not part of any row we kept —
			// otherwise "go back to where I was" is unexpressible.
			out.focus.ref = known >= 0 ? collected[known].ref : snapRef(focusEl);
		}
		out.counts = {
			rows: out.rows.length,
			items: collected.length,
			popups: out.popups.length
		};
		snapCommit();
		return out;`);
}

/**
 * Does the FOCUSED element IS-the element behind this ref? Identity, not text: duplicate
 * titles in a catalog are normal, and a text match quietly stops on the wrong tile.
 * @param {import('./appprofile.js').AppProfile} profile
 * @param {string} ref
 * @return {string}
 */
export function focusIsRefJs(profile, ref) {
	return withHelpersJs(profile, focusIsRefBody(ref));
}

/**
 * Statements of the ref check, for inlining into a press settle (see state.js focusMatchesBody).
 * @param {string} ref
 * @return {string}
 */
export function focusIsRefBody(ref) {
	return `
		var K = ${JSON.stringify(String(ref))};
		var s = window.__tvDebugSnap;
		if (!s || !s.refs) {
			return {ok: false, refMissing: true,
				reason: 'no snapshot on the page any more (navigation, relaunch, or the 60s TTL) — take a fresh tv_snapshot'};
		}
		var el = s.refs[K];
		if (!el) {
			var n = parseInt(String(K).replace(/[^0-9]/g, ''), 10);
			var why = (isFinite(n) && n < s.min)
				? 'ref ' + K + ' is from an earlier snapshot (#' + s.g + ' hands out ' +
				  ${JSON.stringify(REF_PREFIX)} + s.min + '..' + ${JSON.stringify(REF_PREFIX)} + (s.next - 1) + ')'
				: 'ref ' + K + ' is not in snapshot #' + s.g;
			return {ok: false, refMissing: true, reason: why + ' — take a fresh tv_snapshot'};
		}
		if (!el.parentNode) {
			return {ok: false, refMissing: true,
				reason: 'ref ' + K + ' points at an element that has left the DOM — take a fresh tv_snapshot'};
		}
		var f = focusLeaf();
		return {ok: f === el, detail: focusInfo()};`;
}

/**
 * Drop the ref store now instead of waiting for the TTL.
 * @return {string}
 */
export function snapshotReleaseJs() {
	return `(function(){
		var s = window.__tvDebugSnap;
		if (!s) { return {released: false, reason: 'nothing to release'}; }
		if (s.timer) { try { clearTimeout(s.timer); } catch (e) {} }
		try { delete window.__tvDebugSnap; } catch (e) { window.__tvDebugSnap = null; }
		return {released: true, g: s.g};
	})()`;
}
