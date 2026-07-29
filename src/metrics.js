// Performance.getMetrics handling for tv_profile: turn the CDP array into something diffable,
// and diff two readings.
//
// The CPU profile says where JS burns time; it says nothing about memory or layout. getMetrics
// is one cheap round-trip that answers the other half: JSHeapUsedSize, Nodes, JSEventListeners,
// LayoutCount, RecalcStyleCount and the cumulative Duration counters. Two readings around a
// scenario turn that into "this navigation leaked 400 DOM nodes and 12 listeners".
//
// The metric SET is engine-dependent — Chromium 69 on tizen55 reports a different list than a
// current Chrome — so nothing here whitelists names. Whatever the engine reports is what comes
// back, and the diff is computed over the union of both readings.
//
// Pure functions only: no CDP, no clock, no filesystem. That is what makes them testable in
// test/phase0-offline.mjs without a TV.

/** Enough to kill float noise (0.30000000000000004) without lying about microsecond counters. */
const DIFF_DIGITS = 6;

/**
 * `Performance.getMetrics` returns `[{name, value}, …]`. Nobody wants to search an array.
 * @param {*} raw the `metrics` field of the CDP response
 * @return {Object<string, *>}
 */
export function metricsToMap(raw) {
	/** @type {Object<string, *>} */
	const out = {};
	if (!Array.isArray(raw)) {
		return out;
	}
	for (const m of raw) {
		if (!m || typeof m.name !== 'string' || !m.name) {
			continue;
		}
		out[m.name] = m.value;
	}
	return out;
}

/**
 * Per-metric before/after/diff over the union of both readings.
 *
 * A name missing from one side gets `null` there and a `null` diff instead of being dropped:
 * "this engine started reporting X only after the scenario" is information, not noise. Values
 * that are not numbers are passed through with `diff: null` — subtracting them would invent a
 * number that means nothing.
 *
 * The cumulative Duration counters (LayoutDuration, RecalcStyleDuration, ScriptDuration,
 * TaskDuration — seconds since the engine started counting) are the ones that only make sense
 * as a diff: their absolute values include every frame before the recording began.
 *
 * @param {Object<string, *>} before
 * @param {Object<string, *>} after
 * @return {Object<string, {before: *, after: *, diff: ?number}>}
 */
export function metricsDiff(before, after) {
	const a = before && typeof before === 'object' ? before : {};
	const b = after && typeof after === 'object' ? after : {};
	/** @type {Object<string, {before: *, after: *, diff: ?number}>} */
	const out = {};
	// `before` first so the reading order of the engine survives into the report; then whatever
	// only the second reading knows about.
	for (const name of [...Object.keys(a), ...Object.keys(b)]) {
		if (out[name]) {
			continue;
		}
		const from = name in a ? a[name] : null;
		const to = name in b ? b[name] : null;
		const diff = typeof from === 'number' && typeof to === 'number' && Number.isFinite(from) && Number.isFinite(to)
			? round(to - from, DIFF_DIGITS)
			: null;
		out[name] = {before: from, after: to, diff};
	}
	return out;
}

/**
 * Length of the window between two readings, per the engine's own monotonic clock.
 *
 * `Timestamp` is seconds of engine uptime, so its diff is the honest window length — unlike
 * wall-clock on the host, which also counts the CDP round-trips. Absent on engines that don't
 * report it, hence the null.
 * @param {Object<string, {diff: ?number}>} diff output of metricsDiff
 * @return {?number}
 */
export function windowSecondsOf(diff) {
	const t = diff && diff.Timestamp;
	return t && typeof t.diff === 'number' ? round(t.diff, 3) : null;
}

function round(n, digits) {
	const f = Math.pow(10, digits);
	return Math.round((Number(n) || 0) * f) / f;
}
