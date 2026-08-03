// Network-log handling for tv_network: filtering the request ring buffer and turning what it
// holds into something a human can act on — a list entry, a curl command, a HAR file.
//
// Everything here is pure: it takes records the CDP session already buffered (see cdp.js) and
// returns plain data. That is deliberate. `list` has to answer after the app has died — the
// buffer outlives the page — and the curl/HAR builders are exactly the parts worth testing
// without a TV in the room.
//
// The class of regression this exists for is "the request went out, but not the right one":
// analytics that silently lost a field, an API call with a parameter dropped, a stat event
// fired twice. A failed request is already visible in tv_console; a successful one with the
// wrong body was invisible to every case.

/** URLs in a list entry are cut here — a signed media URL is a kilobyte of query string. */
export const LIST_URL_LIMIT = 500;
/** POST bodies in a list entry. The full body (up to the buffer cap) is kept for curl/HAR. */
export const LIST_POSTDATA_LIMIT = 1000;
/** One response body read back through `action:"body"` or into a HAR. */
export const BODY_LIMIT_BYTES = 256 * 1024;
/** All bodies of one HAR file together. */
export const HAR_BODY_TOTAL_LIMIT = 50 * 1024 * 1024;

/**
 * Header names whose value is a credential. Redacted in curl unless `raw:true` — a command
 * pasted into a ticket must not carry the session it was recorded with.
 */
const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key)$/i;
const SECRET_HEADER_PART = /(token|secret|apikey|api-key|session|password)/i;
/** curl sets these itself; copying them makes the command wrong, not more faithful. */
const SKIP_HEADER = /^(content-length|host)$/i;

/**
 * Build a URL predicate. `/…/flags` is a regex, anything else a case-insensitive substring.
 * @param {?string} pattern
 * @return {?function(string): boolean}
 */
export function compileUrlPattern(pattern) {
	if (pattern == null || pattern === '') {
		return null;
	}
	const s = String(pattern);
	const m = /^\/(.+)\/([a-z]*)$/.exec(s);
	if (m) {
		let re;
		try {
			re = new RegExp(m[1], m[2]);
		} catch (e) {
			throw new Error(`urlPattern ${s} is not a valid regex: ${e.message}`);
		}
		return (url) => re.test(String(url || ''));
	}
	const needle = s.toLowerCase();
	return (url) => String(url || '').toLowerCase().includes(needle);
}

/**
 * @param {object} filter
 * @return {?{failed?: boolean, exact?: number, min?: number, max?: number}}
 */
function normalizeStatus(filter) {
	const raw = filter.status;
	const min = filter.statusMin != null ? Number(filter.statusMin) : null;
	const max = filter.statusMax != null ? Number(filter.statusMax) : null;
	let out = null;
	if (raw === 'failed') {
		out = {failed: true};
	} else if (raw != null && raw !== '') {
		if (typeof raw === 'object') {
			const lo = raw.min != null ? Number(raw.min) : null;
			const hi = raw.max != null ? Number(raw.max) : null;
			if (lo == null && hi == null) {
				throw new Error('status as an object needs `min` and/or `max`');
			}
			out = {};
			if (lo != null) {
				out.min = lo;
			}
			if (hi != null) {
				out.max = hi;
			}
		} else {
			const n = Number(raw);
			if (!Number.isFinite(n)) {
				throw new Error(`status must be "failed", a number or {min, max}, got ${JSON.stringify(raw)}`);
			}
			out = {exact: n};
		}
	}
	if (min != null || max != null) {
		out = out && !out.failed ? out : {};
		if (min != null) {
			out.min = min;
		}
		if (max != null) {
			out.max = max;
		}
	}
	return out;
}

/**
 * Compile a filter once so a poll loop does not recompile a regex on every tick.
 * @param {{urlPattern?: string, method?: string, status?: *, statusMin?: number,
 *          statusMax?: number, since?: number, bodyContains?: string}} [filter]
 */
export function normalizeFilter(filter = {}) {
	return {
		matchUrl: compileUrlPattern(filter.urlPattern),
		method: filter.method ? String(filter.method).toUpperCase() : null,
		status: normalizeStatus(filter),
		since: filter.since != null ? Number(filter.since) : null,
		bodyContains: filter.bodyContains != null ? String(filter.bodyContains) : null
	};
}

/**
 * @param {object} rec buffered request record
 * @param {object} norm output of normalizeFilter
 * @return {boolean}
 */
export function matchesRequest(rec, norm) {
	if (!rec) {
		return false;
	}
	if (norm.since != null && !(rec.receivedAt >= norm.since)) {
		return false;
	}
	if (norm.matchUrl && !norm.matchUrl(rec.url)) {
		return false;
	}
	if (norm.method && String(rec.method || '').toUpperCase() !== norm.method) {
		return false;
	}
	if (norm.status) {
		if (norm.status.failed) {
			if (!rec.failed) {
				return false;
			}
		} else {
			// A request still in flight has no status yet — it cannot satisfy a status filter,
			// and pretending 0 would make `statusMax: 399` match everything unanswered.
			if (rec.status == null) {
				return false;
			}
			if (norm.status.exact != null && rec.status !== norm.status.exact) {
				return false;
			}
			if (norm.status.min != null && rec.status < norm.status.min) {
				return false;
			}
			if (norm.status.max != null && rec.status > norm.status.max) {
				return false;
			}
		}
	}
	// Case-sensitive on purpose, unlike the URL: this matches JSON keys and values, where
	// `event_id` and `Event_Id` are different fields.
	if (norm.bodyContains != null && !String(rec.postData || '').includes(norm.bodyContains)) {
		return false;
	}
	return true;
}

/**
 * @param {Array<object>} records buffer, oldest first
 * @param {object} [filter]
 * @return {Array<object>} matches, oldest first
 */
export function selectRequests(records, filter = {}) {
	const norm = normalizeFilter(filter);
	return (records || []).filter((r) => matchesRequest(r, norm));
}

/**
 * The token-sized shape of one request. Bodies are cut here — a POST body carries tokens and
 * cookies, and a report is not the place for them.
 * @param {object} rec
 */
export function toListEntry(rec) {
	const url = String(rec.url || '');
	const entry = {
		requestId: rec.requestId,
		seq: rec.seq,
		receivedAt: rec.receivedAt,
		method: rec.method || '',
		url: url.slice(0, LIST_URL_LIMIT),
		status: rec.status != null ? rec.status : null,
		mimeType: rec.mimeType || null,
		resourceType: rec.resourceType || null,
		encodedDataLength: rec.encodedDataLength || 0
	};
	if (url.length > LIST_URL_LIMIT) {
		entry.urlTruncated = true;
	}
	if (rec.postData != null) {
		const shown = String(rec.postData).slice(0, LIST_POSTDATA_LIMIT);
		entry.postData = shown;
		if (shown.length < String(rec.postData).length || rec.postDataTruncated) {
			entry.postDataTruncated = true;
		}
	} else if (rec.postDataPending) {
		// The engine said there is a body but did not put it in the event.
		entry.postDataPending = true;
	}
	if (rec.failed) {
		entry.failed = true;
		entry.errorText = rec.errorText || null;
		if (rec.blockedReason) {
			entry.blockedReason = rec.blockedReason;
		}
	}
	if (rec.fromCache) {
		entry.fromCache = true;
	}
	if (rec.redirectFrom) {
		entry.redirectFrom = String(rec.redirectFrom).slice(0, LIST_URL_LIMIT);
	}
	if (rec.redirectedTo) {
		entry.redirectedTo = String(rec.redirectedTo).slice(0, LIST_URL_LIMIT);
	}
	if (!rec.finished) {
		entry.inFlight = true;
	}
	return entry;
}

/**
 * @param {string} s
 * @return {string} single-quoted for /bin/sh
 */
export function shellQuote(s) {
	return `'${String(s).split("'").join(`'\\''`)}'`;
}

/**
 * @param {?object} headers
 * @param {boolean} raw
 * @return {{list: Array<[string, string]>, redacted: Array<string>}}
 */
function prepareHeaders(headers, raw) {
	const list = [];
	const redacted = [];
	for (const [name, value] of Object.entries(headers || {})) {
		// HTTP/2 pseudo-headers (`:method`, `:authority`) are the wire form of things curl
		// derives from the URL — copying them produces a command curl refuses.
		if (name.startsWith(':') || SKIP_HEADER.test(name)) {
			continue;
		}
		const secret = SECRET_HEADER.test(name) || SECRET_HEADER_PART.test(name);
		if (secret && !raw) {
			redacted.push(name);
			list.push([name, 'REDACTED']);
		} else {
			list.push([name, String(value)]);
		}
	}
	return {list, redacted};
}

/**
 * A runnable curl for one recorded request — the thing you paste into a ticket or a terminal.
 *
 * The honesty of the headers depends on the engine: `requestWillBeSentExtraInfo` (Chromium 63+)
 * carries what really went on the wire, Cookie and User-Agent included. Older TVs only give
 * what the app itself set, so the replay may not be authenticated — that is a warning, not a
 * silent difference.
 * @param {object} rec
 * @param {{raw?: boolean, postDataLimit?: number}} [opts]
 * @return {{command: string, warnings: Array<string>}}
 */
export function buildCurl(rec, opts = {}) {
	const raw = !!opts.raw;
	const warnings = [];
	const method = String(rec.method || 'GET').toUpperCase();
	const parts = ['curl'];
	if (method !== 'GET') {
		parts.push('-X', method);
	}
	parts.push(shellQuote(rec.url || ''));
	const {list, redacted} = prepareHeaders(rec.requestHeaders, raw);
	for (const [name, value] of list) {
		parts.push('-H', shellQuote(`${name}: ${value}`));
	}
	if (rec.postData != null && rec.postData !== '') {
		parts.push('--data-raw', shellQuote(rec.postData));
	} else if (rec.postDataPending) {
		warnings.push('the engine kept the request body out of the event and it could not be read back — this command has no body');
	}
	if (redacted.length) {
		warnings.push(`${redacted.join(', ')} replaced with REDACTED — pass raw:true for a command that actually authenticates`);
	}
	if (rec.postDataTruncated) {
		const kb = Math.round((opts.postDataLimit || 65536) / 1024);
		warnings.push(`the body was truncated at ${kb}KB when it was buffered, so the curl body is incomplete`);
	}
	if (!rec.headersFromWire) {
		warnings.push(
			'this engine has no requestWillBeSentExtraInfo (Chromium <63): the headers are what the app set, ' +
			'before the engine added Cookie/User-Agent — cookies may be missing when you replay it'
		);
	}
	return {command: parts.join(' '), warnings};
}

/**
 * @param {?object} headers
 * @return {Array<{name: string, value: string}>}
 */
function headerArray(headers) {
	return Object.entries(headers || {}).map(([name, value]) => ({name, value: String(value)}));
}

/**
 * @param {?object} headers
 * @param {string} wanted lower-case name
 * @return {?string}
 */
function headerValue(headers, wanted) {
	for (const [name, value] of Object.entries(headers || {})) {
		if (name.toLowerCase() === wanted) {
			return String(value);
		}
	}
	return null;
}

function queryStringOf(url) {
	try {
		const out = [];
		new URL(String(url)).searchParams.forEach((value, name) => out.push({name, value}));
		return out;
	} catch {
		// A relative or malformed URL is not worth failing a whole HAR over.
		return [];
	}
}

function round3(n) {
	return Math.round(Number(n) * 1000) / 1000;
}

/**
 * HAR timings from the engine's `response.timing`. Everything the engine did not give is `-1`,
 * which is what the HAR spec says "unknown" looks like — inventing a plausible number here
 * would show up as a real waterfall in DevTools.
 * @param {object} rec
 */
function harTimings(rec) {
	const out = {blocked: -1, dns: -1, connect: -1, ssl: -1, send: -1, wait: -1, receive: -1};
	const t = rec.timing;
	if (!t) {
		return out;
	}
	const span = (a, b) => (typeof a === 'number' && typeof b === 'number' && a >= 0 && b >= a ? round3(b - a) : -1);
	out.dns = span(t.dnsStart, t.dnsEnd);
	out.connect = span(t.connectStart, t.connectEnd);
	out.ssl = span(t.sslStart, t.sslEnd);
	out.send = span(t.sendStart, t.sendEnd);
	out.wait = span(t.sendEnd, t.receiveHeadersEnd);
	if (rec.finishedAt && rec.receivedAt && typeof t.receiveHeadersEnd === 'number' && t.receiveHeadersEnd >= 0) {
		// The only place two clocks meet: `receivedAt`/`finishedAt` are host time, the timing
		// offsets are the engine's. Both are measured from the same request, so the difference
		// is the body download to within the CDP delivery skew — good enough for a waterfall,
		// which is why it is here and not in an assertion.
		const total = rec.finishedAt - rec.receivedAt;
		out.receive = total > t.receiveHeadersEnd ? round3(total - t.receiveHeadersEnd) : -1;
	}
	return out;
}

/**
 * One HAR entry.
 * @param {object} rec
 * @param {?{body?: string, base64Encoded?: boolean, truncated?: boolean, error?: string}} body
 */
function harEntry(rec, body, withBodies) {
	const timings = harTimings(rec);
	const time = Object.values(timings).reduce((a, v) => (v > 0 ? a + v : a), 0);
	const contentType = headerValue(rec.responseHeaders, 'content-type') || rec.mimeType || '';
	const entry = {
		startedDateTime: new Date(rec.receivedAt).toISOString(),
		time: time > 0 ? round3(time) : -1,
		request: {
			method: String(rec.method || 'GET').toUpperCase(),
			url: String(rec.url || ''),
			httpVersion: rec.protocol || '',
			cookies: [],
			headers: headerArray(rec.requestHeaders),
			queryString: queryStringOf(rec.url),
			headersSize: -1,
			bodySize: rec.postData != null ? Buffer.byteLength(String(rec.postData)) : (rec.postDataPending ? -1 : 0)
		},
		response: {
			status: rec.status != null ? rec.status : 0,
			statusText: rec.statusText || '',
			httpVersion: rec.protocol || '',
			cookies: [],
			headers: headerArray(rec.responseHeaders),
			content: {size: rec.encodedDataLength || 0, mimeType: contentType},
			redirectURL: headerValue(rec.responseHeaders, 'location') || rec.redirectedTo || '',
			headersSize: -1,
			bodySize: rec.encodedDataLength != null ? rec.encodedDataLength : -1
		},
		cache: {},
		timings
	};
	if (rec.postData != null) {
		entry.request.postData = {
			mimeType: headerValue(rec.requestHeaders, 'content-type') || 'application/octet-stream',
			text: String(rec.postData)
		};
	}
	if (body && typeof body.body === 'string') {
		entry.response.content.text = body.body;
		entry.response.content.size = body.base64Encoded
			? Math.floor((body.body.length * 3) / 4)
			: Buffer.byteLength(body.body);
		if (body.base64Encoded) {
			entry.response.content.encoding = 'base64';
		}
		if (body.truncated) {
			entry.response.content.comment = `truncated by tv-debug-mcp at ${BODY_LIMIT_BYTES} bytes`;
		}
	} else if (rec.failed) {
		entry.comment = `request failed: ${rec.errorText || 'unknown error'}`;
	} else if (rec.redirectedTo) {
		entry.comment = 'redirect hop — no response body by definition';
	} else if (body && body.error) {
		entry.comment = `body unavailable: ${body.error}`;
	} else if (!withBodies) {
		entry.comment = 'body not requested (withBodies:false)';
	} else {
		entry.comment = 'body evicted — the engine no longer had it when the HAR was written';
	}
	return entry;
}

/**
 * A HAR 1.2 log: opens in DevTools → Network → Import, Charles, Insomnia, and is the ready
 * attachment for a bug report.
 *
 * Headers go in as they are, deliberately — a HAR with the Cookie stripped cannot reproduce
 * anything, which is the whole point of the file. The tool description is where the "do not
 * paste this into a public ticket" warning lives.
 * @param {Array<object>} records
 * @param {{bodies?: Map<number, object>, version?: string, withBodies?: boolean}} [opts]
 */
export function buildHar(records, opts = {}) {
	const bodies = opts.bodies instanceof Map ? opts.bodies : new Map();
	const withBodies = opts.withBodies !== false;
	const entries = [...(records || [])]
		.sort((a, b) => (a.receivedAt - b.receivedAt) || (a.seq - b.seq))
		.map((rec) => harEntry(rec, bodies.get(rec.seq), withBodies));
	return {
		log: {
			version: '1.2',
			creator: {name: 'tv-debug-mcp', version: String(opts.version || '0')},
			pages: [],
			entries
		}
	};
}

/**
 * Cut a body to the guard size. Base64 is cut on a 4-character boundary so what comes back is
 * still decodable.
 * @param {string} body
 * @param {boolean} base64Encoded
 * @param {number} [limit]
 * @return {{body: string, bytes: number, truncated: boolean}}
 */
export function capBody(body, base64Encoded, limit = BODY_LIMIT_BYTES) {
	const text = String(body == null ? '' : body);
	const bytes = base64Encoded ? Math.floor((text.length * 3) / 4) : Buffer.byteLength(text);
	if (bytes <= limit) {
		return {body: text, bytes, truncated: false};
	}
	if (base64Encoded) {
		const keep = Math.floor((limit / 3) * 4 / 4) * 4;
		return {body: text.slice(0, keep), bytes, truncated: true};
	}
	return {body: Buffer.from(text, 'utf8').slice(0, limit).toString('utf8'), bytes, truncated: true};
}
