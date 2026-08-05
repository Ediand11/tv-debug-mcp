// Thin Chrome DevTools Protocol client over a raw WebSocket.
//
// Works across TV Chromium generations (38 on webOS 3 through 120+ on modern sets):
// `Runtime.enable` is required, the rest of the domains are enabled best-effort and an
// engine that answers "method not found" is fine. Console/exceptions are buffered
// continuously so `tv_console` can report everything since launch.
//
// Failure handling is the point of this file: a TV that drops the socket, powers off or
// goes to sleep must fail ONE tool call, never the MCP process. Every terminal path
// (`error`, `close`, explicit `close()`) funnels through one idempotent `_disconnect()`
// that rejects the pending calls and marks the session dead, and a permanent `error`
// listener keeps `ws` from raising an unhandled EventEmitter error.
//
// `Page.captureScreenshot` is wrapped in a timeout because on some Samsung sets it hangs
// forever (secure/overlay framebuffer).

import WebSocket from 'ws';

const DEFAULT_CALL_TIMEOUT = 8000;
const MAX_BUFFER = 500;
const MAX_INFLIGHT_REQUESTS = 2000;
/**
 * The network log gets its own, bigger limit: an app fires requests far more often than it
 * logs, and eviction costs more here — an assertion about a request that fell out of the
 * buffer fails silently. `dropped.network` is reported with every list so it cannot lie.
 */
const MAX_NETWORK_BUFFER = 1000;
/** Per record, per direction. Enough for real headers, bounded for 1000 of them. */
export const MAX_HEADERS_BYTES = 8 * 1024;
/** Full POST body kept for curl/HAR; the list view cuts it much shorter (see network.js). */
export const MAX_POSTDATA_BYTES = 64 * 1024;
/** ExtraInfo events can arrive before the request they belong to — bounded stash for those. */
const MAX_PENDING_EXTRA_INFO = 200;

/**
 * A protocol error that means "this engine does not know this method" — expected on old
 * TV Chromium and safe to ignore when enabling optional domains.
 * @param {Error & {protocolCode?: number}} err
 * @return {boolean}
 */
export function isUnsupportedMethod(err) {
	return err.protocolCode === -32601 || /not (implemented|supported|found)/i.test(err.message || '');
}

export class CdpSession {
	/**
	 * @param {string} wsUrl
	 */
	constructor(wsUrl) {
		this._wsUrl = wsUrl;
		/** @type {?WebSocket} */
		this._ws = null;
		this._id = 0;
		/** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
		this._pending = new Map();
		/** @type {Array<object>} */
		this.console = [];
		/** @type {Array<object>} */
		this.exceptions = [];
		/** @type {Array<object>} */
		this.networkFailures = [];
		/**
		 * Full request log since launch — url, method, status, headers, POST body. The records
		 * are mutated in place as `responseReceived`/`loadingFinished` land, so what is in this
		 * array and what is in `_requests` is the same object.
		 * @type {Array<object>}
		 */
		this.network = [];
		/** Entries evicted from the ring buffers, so reports can say so instead of lying. */
		this.dropped = {console: 0, exceptions: 0, networkFailures: 0, network: 0};
		this._requests = new Map();
		/** Monotonic id: `requestId` is reused across redirect hops, this one never is. */
		this._netSeq = 0;
		/** @type {Map<string, {request?: object, response?: object}>} */
		this._pendingExtraInfo = new Map();
		/**
		 * Extra per-method event subscribers (see `onEvent`). The ring buffers above are for
		 * things worth keeping for the whole session; this is for a caller that needs a
		 * stream while it runs — a heap snapshot arriving in thousands of chunks, for one.
		 * @type {Map<string, Set<Function>>}
		 */
		this._eventHandlers = new Map();
		/** @type {?Error} set once the socket is gone; every later call fails with it. */
		this._deadReason = null;
		/**
		 * True on the pre-M54 `Runtime.evaluate` dialect: the reply carries `wasThrown` instead
		 * of `exceptionDetails`, and the `awaitPromise` flag does not exist — a promise-based
		 * page expression comes back as an unresolved object, so those need a two-call path
		 * (session.js videoState).
		 *
		 * This is a PROTOCOL fact, not an engine one. It covers WebKit 538 (webOS 2) *and*
		 * pre-V8-inspector Blink — Chrome 38/47/53, i.e. webos3/tizen3/webos4 — because
		 * `awaitPromise` and `exceptionDetails` landed in the same protocol generation that
		 * retired `wasThrown`. Do not read this flag as "is WebKit": gate engine-specific
		 * behaviour on the UA instead. Detected from the probe evaluate in connect().
		 */
		this.legacyEvalDialect = false;
	}

	/** @return {boolean} */
	get isOpen() {
		return !this._deadReason && !!this._ws && this._ws.readyState === WebSocket.OPEN;
	}

	async connect() {
		const ws = new WebSocket(this._wsUrl, {maxPayload: 96 * 1024 * 1024});
		this._ws = ws;
		ws.on('message', (raw) => this._onMessage(raw));
		// Permanent listeners. Without an 'error' listener a post-handshake socket error is
		// an unhandled EventEmitter error and takes the whole MCP process down.
		ws.on('error', (e) => this._disconnect(e instanceof Error ? e : new Error(String(e))));
		ws.on('close', () => this._disconnect(new Error('CDP connection closed')));

		await new Promise((resolve, reject) => {
			const onOpen = () => {
				ws.removeListener('error', onError);
				resolve();
			};
			const onError = (e) => {
				ws.removeListener('open', onOpen);
				reject(e instanceof Error ? e : new Error(String(e)));
			};
			ws.once('open', onOpen);
			ws.once('error', onError);
		});

		// Runtime is the one domain everything else here depends on.
		await this.call('Runtime.enable', {}, 4000);
		for (const m of ['Page.enable', 'Console.enable', 'Log.enable', 'Network.enable']) {
			try {
				await this.call(m, {}, 4000);
			} catch (e) {
				if (!isUnsupportedMethod(e)) {
					// Not "old engine doesn't have it" — if the socket died, say so instead of
					// handing back a nominally attached session.
					if (!this.isOpen) {
						throw e;
					}
				}
			}
		}
		// Dialect probe — sets `legacyEvalDialect` before the first real caller needs it.
		// A failure here is not fatal: `evaluate()` re-runs the detection on every call.
		await this.evaluate('1', {awaitPromise: false, timeoutMs: 4000}).catch(() => {});
		// Last, so a socket that died during setup — including during the probe, whose own
		// rejection is swallowed above — fails the connect instead of handing back a session
		// that reports itself attached.
		if (!this.isOpen) {
			throw this._deadReason || new Error('CDP socket closed during setup');
		}
		return this;
	}

	/**
	 * Single terminal path: reject everything in flight, mark dead. Idempotent.
	 * @param {Error} err
	 */
	_disconnect(err) {
		if (this._deadReason) {
			return;
		}
		this._deadReason = err;
		for (const {reject, timer} of this._pending.values()) {
			clearTimeout(timer);
			reject(err);
		}
		this._pending.clear();
		// The in-flight map goes, the `network` log does NOT: tv_network must still answer for a
		// session whose TV has just died — that log is often the reason it died.
		this._requests.clear();
		this._pendingExtraInfo.clear();
	}

	_onMessage(raw) {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}
		if (msg.id && this._pending.has(msg.id)) {
			const {resolve, reject, timer} = this._pending.get(msg.id);
			clearTimeout(timer);
			this._pending.delete(msg.id);
			if (msg.error) {
				const err = new Error(msg.error.message || JSON.stringify(msg.error));
				err.protocolCode = msg.error.code;
				reject(err);
			} else {
				resolve(msg.result);
			}
			return;
		}
		this._onEvent(msg.method, msg.params || {});
	}

	/**
	 * Subscribe to a raw CDP event. Returns the unsubscribe function — always call it, a
	 * subscriber that outlives its operation keeps getting fed.
	 * @param {string} method e.g. 'HeapProfiler.addHeapSnapshotChunk'
	 * @param {function(object): void} handler
	 * @return {function(): void}
	 */
	onEvent(method, handler) {
		let set = this._eventHandlers.get(method);
		if (!set) {
			set = new Set();
			this._eventHandlers.set(method, set);
		}
		set.add(handler);
		return () => {
			const live = this._eventHandlers.get(method);
			if (!live) {
				return;
			}
			live.delete(handler);
			if (!live.size) {
				this._eventHandlers.delete(method);
			}
		};
	}

	_onEvent(method, params) {
		const handlers = this._eventHandlers.get(method);
		if (handlers) {
			// Copy: a handler is allowed to unsubscribe itself. A throwing subscriber must not
			// take down the message pump — the operation that installed it will time out instead.
			for (const h of [...handlers]) {
				try {
					h(params);
				} catch {
					// ignore
				}
			}
		}
		switch (method) {
			// modern engines
			case 'Runtime.consoleAPICalled': {
				const loc = (params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0]) || {};
				this._push('console', {
					level: params.type === 'warn' ? 'warning' : params.type,
					text: argsToText(params.args).slice(0, 1000),
					url: loc.url, line: loc.lineNumber, ts: params.timestamp
				});
				break;
			}
			case 'Runtime.exceptionThrown': {
				const d = params.exceptionDetails || {};
				const text = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'Uncaught exception';
				this._push('exceptions', {text: String(text).slice(0, 1400), url: d.url, line: d.lineNumber, ts: params.timestamp});
				break;
			}
			// legacy Chrome 38 (webOS 3)
			case 'Console.messageAdded': {
				const m = params.message || {};
				const bucket = m.level === 'error' ? 'exceptions' : 'console';
				this._push(bucket, {level: m.level, text: String(m.text || '').slice(0, 1000), url: m.url, line: m.line, source: m.source});
				break;
			}
			case 'Log.entryAdded': {
				const e = params.entry || {};
				this._push('console', {level: e.level, text: String(e.text || '').slice(0, 1000), url: e.url, line: e.lineNumber, source: e.source});
				break;
			}
			case 'Network.requestWillBeSent':
				this._onRequestWillBeSent(params);
				break;
			case 'Network.requestWillBeSentExtraInfo':
				this._onExtraInfo(params.requestId, 'request', params);
				break;
			case 'Network.responseReceived': {
				const rec = this._requests.get(params.requestId);
				const r = params.response || {};
				if (rec) {
					rec.status = typeof r.status === 'number' ? r.status : rec.status;
					rec.statusText = r.statusText || rec.statusText || '';
					rec.mimeType = r.mimeType || rec.mimeType || null;
					rec.protocol = r.protocol || rec.protocol || null;
					rec.responseHeaders = capHeaders(r.headers) || rec.responseHeaders;
					rec.timing = r.timing || rec.timing || null;
					rec.fromCache = rec.fromCache || !!r.fromDiskCache;
					if (!rec.resourceType && params.type) {
						rec.resourceType = params.type;
					}
				}
				break;
			}
			case 'Network.responseReceivedExtraInfo':
				this._onExtraInfo(params.requestId, 'response', params);
				break;
			case 'Network.requestServedFromCache': {
				const rec = this._requests.get(params.requestId);
				if (rec) {
					rec.fromCache = true;
				}
				break;
			}
			case 'Network.loadingFailed': {
				const rec = this._requests.get(params.requestId);
				this._requests.delete(params.requestId);
				if (rec) {
					rec.failed = true;
					rec.errorText = params.errorText || 'failed';
					rec.blockedReason = params.blockedReason || null;
					rec.finished = true;
					rec.finishedAt = Date.now();
				}
				// The failure bucket predates the full log and stays as it was: tv_console's
				// contract must not change under a caller that only ever wanted the failures.
				this._push('networkFailures', {
					url: rec ? rec.url : undefined,
					errorText: params.errorText,
					blocked: params.blockedReason || null
				});
				break;
			}
			case 'Network.loadingFinished': {
				const rec = this._requests.get(params.requestId);
				this._requests.delete(params.requestId);
				if (rec) {
					rec.finished = true;
					rec.finishedAt = Date.now();
					if (typeof params.encodedDataLength === 'number') {
						rec.encodedDataLength = params.encodedDataLength;
					}
				}
				break;
			}
			default:
				break;
		}
	}

	/**
	 * Start a record for a request, and close the previous hop when this event is a redirect.
	 *
	 * A redirect reuses the SAME requestId with a `redirectResponse` — so each hop is written as
	 * its own record (`redirectFrom`/`redirectedTo`) instead of overwriting the first one, and
	 * `_netSeq` keeps them apart where the requestId cannot.
	 * @param {object} params
	 */
	_onRequestWillBeSent(params) {
		const req = params.request || {};
		const prev = this._requests.get(params.requestId);
		if (params.redirectResponse && prev) {
			const r = params.redirectResponse;
			prev.status = typeof r.status === 'number' ? r.status : prev.status;
			prev.statusText = r.statusText || prev.statusText || '';
			prev.responseHeaders = capHeaders(r.headers) || prev.responseHeaders;
			prev.mimeType = r.mimeType || prev.mimeType || null;
			prev.timing = r.timing || prev.timing || null;
			prev.redirectedTo = req.url || null;
			prev.finished = true;
			prev.finishedAt = Date.now();
		}
		if (this._requests.size >= MAX_INFLIGHT_REQUESTS) {
			// A page that never finishes its requests must not grow this map forever.
			this._requests.delete(this._requests.keys().next().value);
		}
		const post = capPostData(req.postData);
		const rec = {
			seq: ++this._netSeq,
			requestId: params.requestId,
			// Host clock on purpose: the monotonic engine clocks of two TV generations are not
			// comparable with each other or with this process, and Chrome 38 has no `wallTime`.
			// The host-side receive skew does not matter at QA-assertion resolution.
			receivedAt: Date.now(),
			method: String(req.method || 'GET').toUpperCase(),
			url: req.url || '',
			resourceType: params.type || null,
			requestHeaders: capHeaders(req.headers) || {},
			/** Set once real wire headers arrive (Chromium 63+); curl warns when they never do. */
			headersFromWire: false,
			postData: post.data,
			postDataTruncated: post.truncated,
			postDataPending: post.data == null && !!req.hasPostData,
			status: null,
			statusText: '',
			mimeType: null,
			protocol: null,
			responseHeaders: null,
			timing: null,
			encodedDataLength: 0,
			fromCache: false,
			failed: false,
			errorText: null,
			blockedReason: null,
			finished: false,
			finishedAt: null,
			redirectFrom: params.redirectResponse && prev ? prev.url : null
		};
		const stashed = this._pendingExtraInfo.get(params.requestId);
		if (stashed) {
			this._pendingExtraInfo.delete(params.requestId);
			if (stashed.request) {
				applyRequestExtraInfo(rec, stashed.request);
			}
			if (stashed.response) {
				applyResponseExtraInfo(rec, stashed.response);
			}
		}
		this._requests.set(params.requestId, rec);
		this._push('network', rec);
	}

	/**
	 * `*ExtraInfo` carries the headers that really went on the wire — Cookie and User-Agent
	 * included — and is allowed to arrive before the request event it belongs to.
	 * @param {string} requestId
	 * @param {'request'|'response'} kind
	 * @param {object} params
	 */
	_onExtraInfo(requestId, kind, params) {
		const rec = this._requests.get(requestId);
		if (rec) {
			if (kind === 'request') {
				applyRequestExtraInfo(rec, params);
			} else {
				applyResponseExtraInfo(rec, params);
			}
			return;
		}
		let slot = this._pendingExtraInfo.get(requestId);
		if (!slot) {
			if (this._pendingExtraInfo.size >= MAX_PENDING_EXTRA_INFO) {
				this._pendingExtraInfo.delete(this._pendingExtraInfo.keys().next().value);
			}
			slot = {};
			this._pendingExtraInfo.set(requestId, slot);
		}
		slot[kind] = params;
	}

	/**
	 * @param {'console'|'exceptions'|'networkFailures'|'network'} bucket
	 * @param {object} item
	 */
	_push(bucket, item) {
		const arr = this[bucket];
		const limit = bucket === 'network' ? MAX_NETWORK_BUFFER : MAX_BUFFER;
		arr.push(item);
		if (arr.length > limit) {
			const cut = arr.length - limit;
			arr.splice(0, cut);
			this.dropped[bucket] += cut;
		}
	}

	/**
	 * @param {string} method
	 * @param {object} [params]
	 * @param {number} [timeoutMs]
	 * @return {Promise<object>}
	 */
	call(method, params = {}, timeoutMs = DEFAULT_CALL_TIMEOUT) {
		if (this._deadReason) {
			return Promise.reject(new Error(`CDP session is dead (${this._deadReason.message}) — relaunch with tv_launch`));
		}
		if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error('CDP not connected'));
		}
		const id = ++this._id;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new Error(`CDP call ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this._pending.set(id, {resolve, reject, timer});
			this._ws.send(JSON.stringify({id, method, params}), (err) => {
				// An async send failure would otherwise sit here until the call times out.
				if (err && this._pending.has(id)) {
					clearTimeout(timer);
					this._pending.delete(id);
					reject(err);
				}
			});
		});
	}

	/**
	 * Evaluate an expression in the page. Returns the value (by value) or throws on
	 * a page-side exception.
	 * @param {string} expression
	 * @param {{awaitPromise?: boolean, timeoutMs?: number}} [opts]
	 * @return {Promise<*>}
	 */
	async evaluate(expression, opts = {}) {
		const r = await this.call('Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: opts.awaitPromise !== false
		}, opts.timeoutMs || DEFAULT_CALL_TIMEOUT);
		// Pre-M54 engines set `wasThrown` on every reply, thrown or not; M54+ omit the field
		// entirely and use `exceptionDetails`. Presence alone is therefore the dialect test.
		if (r.wasThrown !== undefined) {
			this.legacyEvalDialect = true;
		}
		if (r.exceptionDetails) {
			const ex = r.exceptionDetails.exception;
			throw new Error('page eval error: ' + ((ex && (ex.description || ex.value)) || r.exceptionDetails.text));
		}
		if (r.wasThrown) {
			// Legacy WebKit engines (webOS 2, WebKit 538) have no exceptionDetails — the thrown
			// error IS the result object. Without this check a page-side throw comes back as a
			// silent `undefined` and e.g. a failed key dispatch looks like success.
			const ex = r.result;
			throw new Error('page eval error: ' + ((ex && (ex.description || ex.value)) || 'exception (wasThrown)'));
		}
		return r.result ? r.result.value : undefined;
	}

	/**
	 * Navigate and wait for the load event (or give up quietly — some TV engines never
	 * fire Page.loadEventFired for a file:// app).
	 * @param {string} url
	 * @param {number} [waitMs]
	 */
	async navigate(url, waitMs = 20000) {
		const loaded = this.waitForLoad(waitMs);
		await this.call('Page.navigate', {url});
		return loaded;
	}

	/**
	 * Resolve when the page fires its load event, or after waitMs — whichever comes first.
	 * Never rejects: it is a "best effort settle" used instead of a blind sleep.
	 * @param {number} [waitMs]
	 * @return {Promise<{loaded: boolean}>}
	 */
	waitForLoad(waitMs = 20000) {
		if (!this._ws) {
			return Promise.resolve({loaded: false});
		}
		return new Promise((resolve) => {
			const ws = this._ws;
			const finish = (loaded) => {
				clearTimeout(timer);
				ws.removeListener('message', onMessage);
				resolve({loaded});
			};
			const onMessage = (raw) => {
				let msg;
				try {
					msg = JSON.parse(raw.toString());
				} catch {
					return;
				}
				if (msg.method === 'Page.loadEventFired') {
					finish(true);
				}
			};
			const timer = setTimeout(() => finish(false), waitMs);
			ws.on('message', onMessage);
		});
	}

	/**
	 * @param {number} [timeoutMs]
	 * @return {Promise<Buffer>}
	 */
	async screenshot(timeoutMs = 6000) {
		const r = await this.call('Page.captureScreenshot', {format: 'png'}, timeoutMs);
		return Buffer.from(r.data, 'base64');
	}

	close() {
		this._disconnect(new Error('CDP session closed locally'));
		try {
			this._ws && this._ws.close();
		} catch {
			// ignore
		}
	}
}

/**
 * Resolve the page target's webSocketDebuggerUrl from a CDP HTTP base
 * (e.g. http://127.0.0.1:9955). Bounded: each attempt has its own timeout and the whole
 * loop has one deadline, so a black-holing TV can't hang a tool call for minutes.
 *
 * Two discovery protocols per attempt: Chromium's `/json/list`, then the legacy WebKit
 * inspector's `/pagelist.json` (webOS 1/2, QtWebKit — no `/json/list` at all). The legacy
 * list has no webSocketDebuggerUrl, but its WS endpoint follows the same
 * `/devtools/page/<id>` shape, so the URL is derived from the id.
 * @param {string} httpBase
 * @param {{attempts?: number, perAttemptMs?: number, deadlineMs?: number}} [opts]
 * @return {Promise<string>}
 */
export async function resolvePageWs(httpBase, opts = {}) {
	const attempts = opts.attempts || 10;
	const perAttemptMs = opts.perAttemptMs || 3000;
	const deadline = Date.now() + (opts.deadlineMs || 20000);
	let lastErr;
	let legacyErr;
	for (let i = 0; i < attempts && Date.now() < deadline; i++) {
		// Each fetch is clamped to what is left of the overall budget: two protocols per
		// attempt would otherwise let one round overshoot the deadline by 2×perAttemptMs.
		const budget = () => Math.max(1, Math.min(perAttemptMs, deadline - Date.now()));
		try {
			const list = await fetchJson(httpBase + '/json/list', budget());
			const page = list.find((t2) => t2.type === 'page' && t2.webSocketDebuggerUrl) ||
				list.find((t2) => t2.webSocketDebuggerUrl);
			if (page) {
				return page.webSocketDebuggerUrl;
			}
			lastErr = new Error('no inspectable target in /json/list');
		} catch (e) {
			lastErr = e;
		}
		// Tried unconditionally, even when /json/list answered 200 with nothing usable: the
		// one device this branch exists for cannot be re-tested cheaply, so an extra request
		// is the right price for not depending on a guess about what its inspector serves.
		try {
			const pages = await fetchJson(httpBase + '/pagelist.json', budget());
			if (!Array.isArray(pages)) {
				throw new Error('/pagelist.json is not an array');
			}
			// Legacy entries carry no `type`; skip the inspector's own scaffolding pages.
			const real = pages.filter((p) => p.id != null);
			const page = real.find((p) => p.url && !/^(about:|inspector:)/.test(p.url)) || real[0];
			if (page) {
				return httpBase.replace(/^http/, 'ws') + '/devtools/page/' + page.id;
			}
			legacyErr = new Error('no inspectable target in /pagelist.json');
		} catch (e) {
			legacyErr = e;
		}
		await sleep(500);
	}
	const why = [lastErr && lastErr.message, legacyErr && legacyErr.message].filter(Boolean).join('; ');
	throw new Error(`no inspectable page at ${httpBase}${why ? ' (' + why + ')' : ''}`);
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @return {Promise<*>}
 */
async function fetchJson(url, timeoutMs) {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, {signal: ac.signal});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} from ${url}`);
		}
		return await res.json();
	} finally {
		clearTimeout(t);
	}
}

/**
 * Copy headers under a byte cap: 1000 records × unbounded headers is the one place this buffer
 * could really cost memory. Names are kept as the engine sent them.
 * @param {?object} headers
 * @return {?object}
 */
function capHeaders(headers) {
	if (!headers || typeof headers !== 'object') {
		return null;
	}
	const out = {};
	let bytes = 0;
	for (const [name, value] of Object.entries(headers)) {
		const v = String(value);
		bytes += name.length + v.length + 4;
		if (bytes > MAX_HEADERS_BYTES) {
			out['x-tv-debug-headers-truncated'] = 'true';
			break;
		}
		out[name] = v;
	}
	return out;
}

/**
 * @param {*} postData
 * @return {{data: ?string, truncated: boolean}}
 */
function capPostData(postData) {
	if (typeof postData !== 'string' || postData === '') {
		return {data: postData === '' ? '' : null, truncated: false};
	}
	if (Buffer.byteLength(postData) <= MAX_POSTDATA_BYTES) {
		return {data: postData, truncated: false};
	}
	return {data: Buffer.from(postData, 'utf8').slice(0, MAX_POSTDATA_BYTES).toString('utf8'), truncated: true};
}

/**
 * @param {object} rec
 * @param {object} params `Network.requestWillBeSentExtraInfo`
 */
function applyRequestExtraInfo(rec, params) {
	const wire = capHeaders(params.headers);
	if (!wire) {
		return;
	}
	// The wire headers are a superset of what the app set — merged, not replaced, so a header
	// the engine reports only in the request event survives.
	rec.requestHeaders = {...(rec.requestHeaders || {}), ...wire};
	rec.headersFromWire = true;
}

/**
 * @param {object} rec
 * @param {object} params `Network.responseReceivedExtraInfo`
 */
function applyResponseExtraInfo(rec, params) {
	const wire = capHeaders(params.headers);
	if (wire) {
		rec.responseHeaders = {...(rec.responseHeaders || {}), ...wire};
	}
	if (typeof params.statusCode === 'number' && rec.status == null) {
		rec.status = params.statusCode;
	}
}

function argsToText(args = []) {
	return args
		.map((a) => {
			if (a.value !== undefined) {
				return String(a.value);
			}
			if (a.description) {
				return a.description;
			}
			if (a.preview) {
				return '{' + (a.preview.properties || []).map((p) => `${p.name}: ${p.value}`).join(', ') + '}';
			}
			return a.type;
		})
		.join(' ');
}

export function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
