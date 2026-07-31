// `.heapsnapshot` handling for tv_heap: read what the device streamed to disk and boil it
// down to something worth putting in a tool response.
//
// The file format is self-describing: `snapshot.meta.node_fields` names the columns of the
// flat `nodes` array and `snapshot.meta.node_types` gives the enum values of the typed ones,
// so nothing here hardcodes a field order — that order really has changed across the
// Chromium generations this park spans (`detachedness` only exists from ~Chromium 80).
//
// Two deliberate limits, both of them the reason the raw file is kept:
//   * only `nodes` and `strings` are parsed. `edges` is 3-5x bigger and is what a retainer
//     graph needs — retainer paths and retained (dominator) sizes are a DevTools job:
//     Memory -> Load. What is computed here is the Summary view: count and SHALLOW size
//     per constructor.
//   * a snapshot bigger than MAX_PARSE_BYTES is not parsed at all. A 300MB snapshot is a
//     normal one for a TV app, and JSON.parse of it costs multiple gigabytes of Node heap;
//     past the limit the answer is a warning plus the path, never a dead MCP process.
//
// Detached DOM nodes are the point of most of this: V8 names them "Detached <div>" /
// "Detached HTMLDivElement", and newer engines additionally flag them in a `detachedness`
// column (2 = detached). Both are honoured, and a node flagged but not named gets the same
// "Detached " prefix so it lands in the same bucket in the summary and in a diff.

import {readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';

/** Past this, parsing costs more RAM than the answer is worth. */
const MAX_PARSE_BYTES = 500 * 1024 * 1024;
const DETACHED_PREFIX = 'Detached ';

/**
 * Bucket names for node types that have no constructor of their own, matching what the
 * DevTools Summary view calls them.
 */
const TYPE_BUCKET = {
	'hidden': '(system)',
	'array': '(array)',
	'string': '(string)',
	'concatenated string': '(string)',
	'sliced string': '(string)',
	'code': '(compiled code)',
	'number': '(number)',
	'regexp': '(regexp)',
	'symbol': '(symbol)',
	'bigint': '(bigint)'
};

/**
 * @typedef {{path: string, bytes: number, totalNodes: number, totalSize: number,
 *            detachedCount: number, detachedSize: number,
 *            byName: Map<string, {count: number, shallowBytes: number}>}} HeapTally
 */

/**
 * Read a `.heapsnapshot` and tally count + shallow size per constructor.
 * @param {string} path
 * @return {HeapTally}
 */
function tally(path) {
	const abs = resolve(path);
	const bytes = statSync(abs).size;
	if (bytes > MAX_PARSE_BYTES) {
		const e = new Error(
			`heap snapshot ${abs} is ${mb(bytes)}MB, over the ${mb(MAX_PARSE_BYTES)}MB parse limit — ` +
			'the file is intact, open it in Chrome DevTools -> Memory -> Load'
		);
		e.tooBig = true;
		e.bytes = bytes;
		throw e;
	}
	const raw = readFileSync(abs, 'utf8');
	const {meta, nodes, strings} = parseSections(raw, abs);

	const fields = meta.node_fields;
	const typeIdx = fields.indexOf('type');
	const nameIdx = fields.indexOf('name');
	const sizeIdx = fields.indexOf('self_size');
	const detachedIdx = fields.indexOf('detachedness');
	if (nameIdx < 0 || sizeIdx < 0) {
		throw new Error(`unusable heap snapshot: node_fields has no name/self_size (${fields.join(',')})`);
	}
	const stride = fields.length;
	// node_types is parallel to node_fields: an array for an enum column, a plain type name
	// for the rest. An engine that reports the type as a plain number is fine too.
	const typeNames = typeIdx >= 0 && Array.isArray(meta.node_types) && Array.isArray(meta.node_types[typeIdx])
		? meta.node_types[typeIdx]
		: null;

	/** @type {Map<string, {count: number, shallowBytes: number}>} */
	const byName = new Map();
	let totalSize = 0;
	let detachedCount = 0;
	let detachedSize = 0;
	let totalNodes = 0;

	for (let i = 0; i + stride <= nodes.length; i += stride) {
		const selfSize = nodes[i + sizeIdx] || 0;
		const rawName = strings[nodes[i + nameIdx]];
		const type = typeNames ? typeNames[nodes[i + typeIdx]] : null;
		const detached = detachedIdx >= 0 && nodes[i + detachedIdx] === 2;
		let name = classNameOf(type, rawName);
		if (detached || name.startsWith(DETACHED_PREFIX)) {
			if (!name.startsWith(DETACHED_PREFIX)) {
				name = DETACHED_PREFIX + name;
			}
			detachedCount++;
			detachedSize += selfSize;
		}
		const agg = byName.get(name);
		if (agg) {
			agg.count++;
			agg.shallowBytes += selfSize;
		} else {
			byName.set(name, {count: 1, shallowBytes: selfSize});
		}
		totalSize += selfSize;
		totalNodes++;
	}

	return {path: abs, bytes, totalNodes, totalSize, detachedCount, detachedSize, byName};
}

/**
 * What the Summary view would call this node.
 * @param {?string} type
 * @param {*} rawName
 * @return {string}
 */
function classNameOf(type, rawName) {
	const name = typeof rawName === 'string' ? rawName : '';
	if (type === 'closure') {
		// Grouping every closure under one bucket hides exactly the leak we are hunting (N
		// copies of one handler); the name is the useful key, `()` marks it as a function.
		return name ? `${name}()` : '(closure)';
	}
	const bucket = TYPE_BUCKET[type];
	if (bucket) {
		return bucket;
	}
	if (name) {
		return name;
	}
	return type ? `(${type})` : '(unknown)';
}

/**
 * Pull `snapshot.meta`, `nodes` and `strings` out of the raw JSON text without parsing
 * `edges` — on a real snapshot that is the majority of the file and it is not needed for a
 * constructor summary. Any surprise in the layout falls back to a plain JSON.parse, so a
 * format change costs memory, never correctness.
 * @param {string} raw
 * @param {string} abs
 * @return {{meta: object, nodes: Array<number>, strings: Array<string>}}
 */
function parseSections(raw, abs) {
	let meta = null;
	let nodes = null;
	let strings = null;
	try {
		const snapshotText = sliceValue(raw, '"snapshot"', '{', '}');
		const nodesText = sliceValue(raw, '"nodes"', '[', ']');
		const stringsText = sliceValue(raw, '"strings"', '[', ']');
		if (snapshotText && nodesText && stringsText) {
			meta = JSON.parse(snapshotText).meta;
			nodes = JSON.parse(nodesText);
			strings = JSON.parse(stringsText);
		}
	} catch {
		meta = nodes = strings = null;
	}
	if (!meta || !Array.isArray(nodes) || !Array.isArray(strings)) {
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			throw new Error(`not a readable .heapsnapshot (${abs}): ${e.message}`);
		}
		meta = parsed.snapshot && parsed.snapshot.meta;
		nodes = parsed.nodes;
		strings = parsed.strings;
	}
	if (!meta || !Array.isArray(meta.node_fields) || !Array.isArray(nodes) || !Array.isArray(strings)) {
		throw new Error(`not a .heapsnapshot: missing snapshot.meta.node_fields / nodes / strings (${abs})`);
	}
	return {meta, nodes, strings};
}

/**
 * Text of the value of a top-level key, by matching brackets. Quote-aware, so a string
 * containing a bracket (every `strings` array has them) cannot end the scan early.
 * @param {string} raw
 * @param {string} key quoted key, e.g. '"nodes"'
 * @param {string} open
 * @param {string} close
 * @return {?string}
 */
function sliceValue(raw, key, open, close) {
	const at = raw.indexOf(key);
	if (at < 0) {
		return null;
	}
	const start = raw.indexOf(open, at + key.length);
	if (start < 0) {
		return null;
	}
	let depth = 0;
	let inString = false;
	for (let i = start; i < raw.length; i++) {
		const c = raw[i];
		if (inString) {
			if (c === '\\') {
				i++;
			} else if (c === '"') {
				inString = false;
			}
			continue;
		}
		if (c === '"') {
			inString = true;
		} else if (c === open) {
			depth++;
		} else if (c === close) {
			depth--;
			if (depth === 0) {
				return raw.slice(start, i + 1);
			}
		}
	}
	return null;
}

/**
 * Summarise one snapshot: totals, detached count, and the top-N constructors by shallow size.
 *
 * A file over the parse limit is NOT an error — the snapshot itself is the deliverable and
 * DevTools can still open it, so this answers with `ok: false` plus a warning.
 * @param {string} path
 * @param {{topN?: number}} [opts]
 * @return {{ok: boolean, warning?: string, bytes?: number, totalNodes?: number,
 *           totalSize?: number, detachedCount?: number, detachedSize?: number,
 *           constructors?: number, topConstructors?: Array<object>}}
 */
export function summarizeHeapSnapshot(path, opts = {}) {
	const topN = topNOf(opts);
	let t;
	try {
		t = tally(path);
	} catch (e) {
		if (e.tooBig) {
			return {ok: false, bytes: e.bytes, warning: e.message};
		}
		throw e;
	}
	return {
		ok: true,
		bytes: t.bytes,
		totalNodes: t.totalNodes,
		totalSize: t.totalSize,
		detachedCount: t.detachedCount,
		detachedSize: t.detachedSize,
		constructors: t.byName.size,
		topConstructors: [...t.byName.entries()]
			.sort((a, b) => b[1].shallowBytes - a[1].shallowBytes || b[1].count - a[1].count)
			.slice(0, topN)
			.map(([name, v]) => ({name, count: v.count, shallowBytes: v.shallowBytes}))
	};
}

/**
 * Compare two snapshots the way the DevTools Comparison view does: delta count and delta
 * shallow size per constructor, growth and shrink separately.
 *
 * Both files are parsed here, every time — a cache keyed on a path would answer with a stale
 * tally the moment a snapshot is overwritten, and a re-parse is seconds against a hunt that
 * takes minutes.
 * @param {string} beforePath
 * @param {string} afterPath
 * @param {{topN?: number}} [opts]
 */
export function diffHeapSummaries(beforePath, afterPath, opts = {}) {
	const topN = topNOf(opts);
	const a = tally(beforePath);
	const b = tally(afterPath);

	const names = new Set([...a.byName.keys(), ...b.byName.keys()]);
	const rows = [];
	for (const name of names) {
		const x = a.byName.get(name) || {count: 0, shallowBytes: 0};
		const y = b.byName.get(name) || {count: 0, shallowBytes: 0};
		const deltaCount = y.count - x.count;
		const deltaBytes = y.shallowBytes - x.shallowBytes;
		if (deltaCount === 0 && deltaBytes === 0) {
			continue;
		}
		rows.push({
			name,
			deltaCount,
			deltaBytes,
			countBefore: x.count,
			countAfter: y.count
		});
	}
	const bySize = (p, q) => q.deltaBytes - p.deltaBytes || q.deltaCount - p.deltaCount;

	return {
		before: side(a),
		after: side(b),
		delta: {
			totalNodes: b.totalNodes - a.totalNodes,
			totalSize: b.totalSize - a.totalSize,
			detachedCount: b.detachedCount - a.detachedCount,
			detachedSize: b.detachedSize - a.detachedSize
		},
		constructorsChanged: rows.length,
		topGrowth: rows.filter((r) => r.deltaBytes > 0 || r.deltaCount > 0).sort(bySize).slice(0, topN),
		topShrink: rows.filter((r) => r.deltaBytes < 0 || r.deltaCount < 0).sort((p, q) => bySize(q, p)).slice(0, topN)
	};
}

/** @param {HeapTally} t */
function side(t) {
	return {
		path: t.path,
		bytes: t.bytes,
		totalNodes: t.totalNodes,
		totalSize: t.totalSize,
		detachedCount: t.detachedCount,
		detachedSize: t.detachedSize
	};
}

function topNOf(opts) {
	return Math.min(200, Math.max(1, Math.floor(opts.topN || 20)));
}

function mb(bytes) {
	return Math.round(bytes / (1024 * 1024));
}
