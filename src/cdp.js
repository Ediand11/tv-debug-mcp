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
		/** Entries evicted from the ring buffers, so reports can say so instead of lying. */
		this.dropped = {console: 0, exceptions: 0, networkFailures: 0};
		this._requests = new Map();
		/**
		 * Extra per-method event subscribers (see `onEvent`). The ring buffers above are for
		 * things worth keeping for the whole session; this is for a caller that needs a
		 * stream while it runs — a heap snapshot arriving in thousands of chunks, for one.
		 * @type {Map<string, Set<Function>>}
		 */
		this._eventHandlers = new Map();
		/** @type {?Error} set once the socket is gone; every later call fails with it. */
		this._deadReason = null;
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
		this._requests.clear();
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
				if (this._requests.size >= MAX_INFLIGHT_REQUESTS) {
					// A page that never finishes its requests must not grow this map forever.
					this._requests.delete(this._requests.keys().next().value);
				}
				this._requests.set(params.requestId, {url: params.request && params.request.url});
				break;
			case 'Network.loadingFailed': {
				const req = this._requests.get(params.requestId) || {};
				this._requests.delete(params.requestId);
				this._push('networkFailures', {url: req.url, errorText: params.errorText, blocked: params.blockedReason || null});
				break;
			}
			case 'Network.loadingFinished':
				this._requests.delete(params.requestId);
				break;
			default:
				break;
		}
	}

	/**
	 * @param {'console'|'exceptions'|'networkFailures'} bucket
	 * @param {object} item
	 */
	_push(bucket, item) {
		const arr = this[bucket];
		arr.push(item);
		if (arr.length > MAX_BUFFER) {
			const cut = arr.length - MAX_BUFFER;
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
		if (r.exceptionDetails) {
			const ex = r.exceptionDetails.exception;
			throw new Error('page eval error: ' + ((ex && (ex.description || ex.value)) || r.exceptionDetails.text));
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
 * @param {string} httpBase
 * @param {{attempts?: number, perAttemptMs?: number, deadlineMs?: number}} [opts]
 * @return {Promise<string>}
 */
export async function resolvePageWs(httpBase, opts = {}) {
	const attempts = opts.attempts || 10;
	const perAttemptMs = opts.perAttemptMs || 3000;
	const deadline = Date.now() + (opts.deadlineMs || 20000);
	let lastErr;
	for (let i = 0; i < attempts && Date.now() < deadline; i++) {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), perAttemptMs);
		try {
			const res = await fetch(httpBase + '/json/list', {signal: ac.signal});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} from ${httpBase}/json/list`);
			}
			const list = await res.json();
			const page = list.find((t2) => t2.type === 'page' && t2.webSocketDebuggerUrl) ||
				list.find((t2) => t2.webSocketDebuggerUrl);
			if (page) {
				return page.webSocketDebuggerUrl;
			}
			lastErr = new Error('no inspectable target in /json/list');
		} catch (e) {
			lastErr = e;
		} finally {
			clearTimeout(t);
		}
		await sleep(500);
	}
	throw new Error(`no inspectable page at ${httpBase}${lastErr ? ' (' + lastErr.message + ')' : ''}`);
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
