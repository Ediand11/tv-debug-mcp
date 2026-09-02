// Compact text renderings of the two answers an agent reads most often, and the cap on the
// one answer that can be arbitrarily large.
//
// tv_snapshot and tv_state are read before nearly every move. As indented JSON they cost
// 1-3 KB a call for a dozen refs and a focus; as lines they read better and cost a third.
// The refs (e1, e2, …) stay literal so tv_goto {ref} keeps working from the text, and a
// caller that needs the structure back asks for format:"json".

/** tv_evaluate results above this are cut — one `document.body.innerHTML` was 50k tokens. */
export const EVAL_CAP_BYTES = 16 * 1024;

/**
 * @param {*} value
 * @return {{value: *, truncated?: boolean, bytes?: number, hint?: string}}
 */
export function capEvalValue(value) {
	const isString = typeof value === 'string';
	const text = isString ? value : JSON.stringify(value);
	if (text === undefined || text.length <= EVAL_CAP_BYTES) {
		return {value};
	}
	return {
		value: text.slice(0, EVAL_CAP_BYTES),
		truncated: true,
		bytes: text.length,
		hint: isString
			? 'the string was cut — narrow the expression (slice it, pick a field) to see a specific part'
			: 'the JSON was cut and is no longer valid — return a smaller object (pick fields, cap arrays) instead of the whole thing'
	};
}

/**
 * @param {?object} f focusInfo
 * @return {string}
 */
function focusLine(f) {
	if (!f) {
		return 'focus: none';
	}
	const parts = [];
	if (f.ref) {
		parts.push(f.ref);
	}
	parts.push(JSON.stringify(f.text || ''));
	parts.push(`${f.path || f.tag || '?'}#${f.index}/${f.total}`);
	if (f.testid) {
		parts.push(`testid=${f.testid}`);
	}
	if (f.visible === false) {
		parts.push('(not visible)');
	}
	return 'focus: ' + parts.join(' ');
}

/**
 * @param {Array<object>} popups
 * @return {string}
 */
function popupLines(popups) {
	if (!popups || !popups.length) {
		return '';
	}
	return '\n' + popups.map((p) => `popup: ${p.className} ${JSON.stringify(p.text || '')}`).join('\n');
}

/**
 * @param {object} st the tv_state answer
 * @return {string}
 */
export function renderStateText(st) {
	if (!st || typeof st !== 'object') {
		return String(st);
	}
	const c = st.counts || {};
	const lines = [
		`${st.title ? JSON.stringify(st.title) + ' ' : ''}${st.url || ''}`,
		`scenes: ${(st.scenes || []).join(' | ') || '-'}`,
		focusLine(st.focus) + (st.focusInMenu ? ' [in menu]' : ''),
		`counts: tiles ${c.tiles || 0}, menuItems ${c.menuItems || 0}, popups ${c.popups || 0}`
	];
	return lines.join('\n') + popupLines(st.popups);
}

/**
 * @param {object} out the tv_snapshot answer
 * @return {string}
 */
export function renderSnapshotText(out) {
	if (!out || typeof out !== 'object' || out.ok === false) {
		return JSON.stringify(out);
	}
	if (out.released !== undefined) {
		return out.released ? `released snapshot #${out.g}` : `nothing to release (${out.reason || ''})`;
	}
	const lines = [];
	lines.push(`snapshot #${out.g} ${out.url || ''}`);
	lines.push(`scenes: ${(out.scenes || []).join(' | ') || '-'}`);
	lines.push(focusLine(out.focus));
	for (const row of out.rows || []) {
		const items = (row.items || []).map((it) => {
			const t = it.t ? ' ' + JSON.stringify(it.t) : '';
			return it.focused ? `[${it.ref}${t}]*` : `[${it.ref}${t}]`;
		});
		let head = `r${row.i}${row.focused ? '*' : ''}`;
		if (row.label) {
			head += ` ${JSON.stringify(row.label)}`;
		}
		lines.push(`${head}: ${items.join(' ')}${row.more ? ` (+${row.more} off-screen)` : ''}`);
	}
	if (out.moreRows) {
		lines.push(`(+${out.moreRows} rows off-screen)`);
	}
	if (out.neighbours) {
		const nb = Object.entries(out.neighbours).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
		lines.push(`neighbours: ${nb.join(' ') || '-'}`);
	}
	if (out.tier) {
		lines.push(`tier: ${out.tier}`);
	}
	if (out.warning) {
		lines.push(`warning: ${out.warning}`);
	}
	return lines.join('\n') + popupLines(out.popups);
}
