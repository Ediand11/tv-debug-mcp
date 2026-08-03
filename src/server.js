#!/usr/bin/env node
// tv-debug-mcp — MCP server for semi-manual QA runs on real Smart TVs over CDP.
//
// Tools: tv_devices, tv_install, tv_launch, tv_press, tv_screenshot, tv_console, tv_network,
// tv_video_state, tv_state, tv_wait_for, tv_goto, tv_menu, tv_sequence, tv_evaluate,
// tv_profile, tv_heap.
// The park is described in devices.json (or TV_DEBUG_CONFIG) and can also contain a `pc`
// device — the same case run against a local Chrome. One persistent CDP session per device
// is kept across calls so console/exceptions accumulate from launch. All progress goes to
// stderr (stdout is the MCP stdio channel).
//
// A failing device must fail ONE tool call: everything below is wrapped so a dead TV,
// a missing sdb or a broken config never takes the stdio server down.

import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema, CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

import {loadConfig, getDevice} from './config.js';
import {DeviceSession, deviceCapabilities} from './session.js';
import {diffHeapSummaries} from './heap.js';
import {knownKeys} from './keymaps.js';
import {parseSdbDevices} from './adapters/tizen.js';

const execFileP = promisify(execFile);
const log = (...a) => console.error('[tv-debug-mcp]', ...a);

/** @type {Map<string, DeviceSession>} */
const sessions = new Map();

function sessionFor(deviceId) {
	const cfg = getDevice(deviceId);
	const existing = sessions.get(cfg.id);
	if (existing && existing.cfg === cfg) {
		return existing;
	}
	if (existing) {
		// devices.json changed under us — drop the session bound to the old config object.
		existing.dispose().catch(() => {});
	}
	const s = new DeviceSession(cfg, log);
	sessions.set(cfg.id, s);
	return s;
}

const DEVICE_PROP = {
	device: {type: 'string', description: 'Device id from devices.json. Omit to use the default device.'}
};

const TOOLS = [
	{
		name: 'tv_devices',
		description: 'List configured TVs, their reachability (sdb/ares) and which operations each supports. Start here to see the park.',
		inputSchema: {type: 'object', properties: {}}
	},
	{
		name: 'tv_install',
		description: 'Install an app package on a TV (.wgt for Tizen, .ipk for webOS). Provide an absolute path. Set uninstallFirst:true when an app signed with a different certificate is already installed.',
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				path: {type: 'string', description: 'Absolute path to the .wgt/.ipk package.'},
				uninstallFirst: {type: 'boolean', description: 'Uninstall the app id from this device before installing (fixes "Author certificate not match").'}
			},
			required: ['path']
		}
	},
	{
		name: 'tv_launch',
		description: 'Debug-launch the app and attach over CDP. Establishes the session used by all other tools. By default it kills any running instance first for a deterministic fresh start. reload:true reloads the page in place (same process, keeps localStorage). relaunch:true forces a fresh kill+launch. attach:true reuses the inspector of an app already running in debug, keeping its state.',
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				reload: {type: 'boolean', description: 'Reload the page in place when already attached (does not clear localStorage).'},
				relaunch: {type: 'boolean', description: 'Force a fresh kill + debug-launch even if already attached.'},
				attach: {type: 'boolean', description: 'Attach to a running instance without killing it (skips the fresh-start kill).'}
			}
		}
	},
	{
		name: 'tv_press',
		description: 'Send a remote key. Names: UP/DOWN/LEFT/RIGHT/ENTER/BACK/MENU/RED/GREEN/YELLOW/BLUE/PLAY/PAUSE/PAGE_UP/... (or a raw numeric keyCode). durationMs holds the key (long-press); repeat+intervalMs sends a burst (e.g. move several tiles). Returns the focused element after the press.',
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				key: {type: 'string', description: 'Key name (case-insensitive) or raw numeric keyCode.'},
				durationMs: {type: 'integer', minimum: 0, maximum: 60000, description: 'Hold duration in ms for a long-press. Omit or 0 for a normal press.'},
				repeat: {type: 'integer', minimum: 1, maximum: 100, description: 'Send the press N times (default 1).'},
				intervalMs: {type: 'integer', minimum: 0, maximum: 10000, description: 'Delay between repeats in ms (default 250).'}
			},
			required: ['key']
		}
	},
	{
		name: 'tv_screenshot',
		description: 'Capture the app frame via CDP and save a PNG. NOTE: on Samsung/Tizen the secure video/overlay plane often makes captureScreenshot hang or return black — for playback verdicts prefer tv_video_state and a human glance at the physical TV. UI screens (menus, focus, tiles) usually capture fine.',
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				path: {type: 'string', description: 'Where to write the PNG. Defaults to a scratch path.'},
				timeoutMs: {type: 'integer', minimum: 500, maximum: 60000, description: 'Give up after this many ms (default 6000).'}
			}
		}
	},
	{
		name: 'tv_console',
		description: 'Console output, uncaught exceptions and failed network requests buffered since launch. Filter by substring and/or level. Reports how many entries were dropped from the ring buffer.',
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				filter: {type: 'string', description: 'Case-insensitive substring filter on message text (and on failed request URLs).'},
				levels: {
					type: 'array',
					items: {type: 'string', enum: ['log', 'info', 'debug', 'warning', 'error']},
					description: 'Console levels to include. Omit for all levels.'
				},
				limit: {type: 'integer', minimum: 1, maximum: 500, description: 'Max entries per bucket (default 60).'}
			}
		}
	},
	{
		name: 'tv_network',
		description: 'The full request log since launch — the tool for "the request went out, but not the right one" (analytics that lost a field, an API call with a parameter dropped, a stat event fired twice). action:"list" (default) returns url, method, status, mime type, size and the POST body of each request, newest first, filtered by urlPattern (substring, or /regex/), method and status ("failed" | a number | {min,max}). action:"body" reads one response body back by requestId — bodies live in the ENGINE buffer only until the page navigates or the app is relaunched, so this answers "why is the catalog empty" right now and cannot be used to re-read history; assert bodies at the moment of the case with a tv_sequence expectRequest step. action:"curl" turns one request into a runnable command for a terminal or a ticket (Cookie/Authorization redacted unless raw:true). action:"har" writes a HAR 1.2 file of the filtered log — importable into DevTools -> Network -> Import or Charles, and a ready proof attachment; it contains cookies and auth headers as they were, so do not put it in a public ticket. action:"mark" moves the assertion window used by expectRequest to now. POST bodies carry tokens: the list cuts them to 1000 characters and full bodies never go into reports. Reading the log needs no live connection — it survives the app dying.',
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				action: {type: 'string', enum: ['list', 'body', 'curl', 'har', 'mark'], description: 'list (default): the log. body/curl: one request by requestId. har: write a .har file. mark: move the expectRequest window to now.'},
				urlPattern: {type: 'string', description: 'list/har: case-insensitive substring of the URL, or /regex/flags.'},
				method: {type: 'string', description: 'list/har: HTTP method (GET, POST, …).'},
				status: {description: 'list/har: "failed", an exact status number, or {"min":200,"max":299}.'},
				limit: {type: 'integer', minimum: 1, maximum: 500, description: 'list: how many requests to return, newest first (default 50).'},
				requestId: {type: 'string', description: 'body/curl: the requestId of a request from action:"list".'},
				raw: {type: 'boolean', description: 'curl: keep Cookie/Authorization values instead of REDACTED (default false).'},
				path: {type: 'string', description: 'har: where to write the .har file. Defaults to a scratch path.'},
				withBodies: {type: 'boolean', description: 'har: read response bodies into the file (default true). They are best-effort: only what the engine still has.'}
			}
		}
	},
	{
		name: 'tv_video_state',
		description: 'Programmatic <video> snapshot: whether currentTime is advancing (two samples), readyState, size, muted, src and MediaError code. The reliable way to confirm playback when a screenshot would be black.',
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				sampleGapMs: {type: 'integer', minimum: 100, maximum: 10000, description: 'Gap between the two currentTime samples (default 600).'}
			}
		}
	},
	{
		name: 'tv_state',
		description: 'Structured snapshot of the app right now: url, title, visible scenes, the focused element (text, class, path, index/total among its siblings), visible popups and element counts. Read-only — use it to assert a step without pressing anything.',
		inputSchema: {type: 'object', properties: {...DEVICE_PROP}}
	},
	{
		name: 'tv_wait_for',
		description: 'Wait until a condition holds, instead of sleeping. Give exactly one condition. stableMs additionally requires it to keep holding, which avoids acting on a half-rendered frame. Returns the elapsed time and the final state.',
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				focusText: {type: 'string', description: "Focused element's text contains this (case-insensitive)."},
				selector: {type: 'string', description: 'A visible element matches this CSS selector.'},
				selectorGone: {type: 'string', description: 'No visible element matches this CSS selector (spinner gone, popup closed).'},
				scene: {type: 'string', description: "A visible scene's class contains this (e.g. player)."},
				text: {type: 'string', description: "The page's visible text contains this."},
				expression: {type: 'string', description: 'ES5 expression that must evaluate truthy.'},
				videoAdvancing: {type: 'boolean', description: 'Wait until <video> currentTime is actually moving.'},
				request: {
					type: 'object',
					description: 'Wait until a matching request has been sent: {"urlPattern":"track","method":"POST","bodyContains":"event_id","statusMax":399}. Matches requests received since this call (or since the last tv_network action:"mark"). "absent":true inverts it — succeeds only if nothing matched by the timeout, which is how a duplicated stat event is caught; it waits out the whole timeout by definition. "count":{"min":1,"max":1} bounds how many matched.'
				},
				timeoutMs: {type: 'integer', minimum: 100, maximum: 300000, description: 'Give up after this long (default 15000; 8000 for a request condition).'},
				intervalMs: {type: 'integer', minimum: 50, maximum: 5000, description: 'Poll interval (default 250).'},
				stableMs: {type: 'integer', minimum: 0, maximum: 10000, description: 'Require the condition to hold this long before succeeding (default 0).'}
			}
		}
	},
	{
		name: 'tv_goto',
		description: 'Press a direction repeatedly until the FOCUSED element matches a target (text / CSS selector / testid). Bounded by maxSteps, a deadline, and two structural stops: focus that stopped moving (edge of a list) and focus that wrapped around to a position already visited. Use this instead of guessing "press DOWN 7 times".',
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				direction: {type: 'string', enum: ['UP', 'DOWN', 'LEFT', 'RIGHT'], description: 'Direction to travel in.'},
				text: {type: 'string', description: "Stop when the focused element's text contains this (case-insensitive)."},
				selector: {type: 'string', description: 'Stop when the focused element matches this CSS selector.'},
				testid: {type: 'string', description: 'Stop when the focused element has this data-testid / data-export-id.'},
				maxSteps: {type: 'integer', minimum: 1, maximum: 200, description: 'Maximum presses (default 30).'},
				deadlineMs: {type: 'integer', minimum: 1000, maximum: 300000, description: 'Wall-clock budget (default 45000).'}
			},
			required: ['direction']
		}
	},
	{
		name: 'tv_menu',
		description: "Move focus into the app's main menu and pick a section by name. Omit `item` to just open the menu and list its sections. Requires a `menu` block in the app profile (apps/<app>.json) — the MCP itself knows nothing about any particular app's markup.",
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				item: {type: 'string', description: 'Section title to select (case-insensitive substring). Omit to only open the menu and list items.'},
				select: {type: 'boolean', description: 'Press ENTER on the item once focused (default true).'},
				maxOpenPresses: {type: 'integer', minimum: 1, maximum: 50, description: 'Upper bound on presses of the menu key while travelling to the sidebar (default 20; it takes one press per column).'}
			}
		}
	},
	{
		name: 'tv_sequence',
		description: 'Run a whole case body in ONE call, with a verdict, elapsed time and result per step. Steps are objects, one key each: {"launch":{"relaunch":true}} (start from a known state) | {"press":"RIGHT","repeat":2} | {"longpress":"ENTER","durationMs":1500} | {"goto":{"direction":"DOWN","text":"..."}} | {"menu":"Settings"} | {"wait":{"scene":"player"},"timeoutMs":30000} | {"expect":{"selector":"[class*=popup]"}} | {"expectRequest":{"urlPattern":"track","method":"POST","bodyContains":"event_id","timeoutMs":8000}} | {"networkMark":true} | {"eval":"ES5 expression"} | {"sleep":1000} | {"videoState":true} | {"state":true} | {"profileStart":true} | {"profileStop":{"path":"…"}} | {"metrics":true}. `expect` and `wait` take the same conditions as tv_wait_for; a failing one fails the step. `expectRequest` asserts on the network log (see tv_network) and matches requests sent since the step began — put {"networkMark":true} before the action to widen the window, use "absent":true or "count":{"max":1} to catch a duplicate (both wait out the whole timeout). Runs under the device lock so nothing interleaves.',
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				steps: {type: 'array', minItems: 1, maxItems: 100, items: {type: 'object'}, description: 'Ordered steps, see the tool description for the shapes.'},
				stopOnFail: {type: 'boolean', description: 'Stop at the first failing step (default true).'}
			},
			required: ['steps']
		}
	},
	{
		name: 'tv_evaluate',
		description: 'Run arbitrary JavaScript in the app page and return the value (escape hatch). Use for custom assertions, reading app state, or restoring localStorage after a debug relaunch. Old TVs are Chrome 38 — keep the expression ES5.',
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				expression: {type: 'string', description: 'JS expression to evaluate in the page.'},
				awaitPromise: {type: 'boolean', description: 'Await a returned promise (default true).'}
			},
			required: ['expression']
		}
	},
	{
		name: 'tv_profile',
		description: 'Record a JS CPU profile on the device, and/or read memory & layout metrics. action:"start" begins sampling, then do the thing you want to measure (tv_press / tv_goto / a scroll), then action:"stop" writes a .cpuprofile file (open it in Chrome DevTools -> Performance -> Load profile) and returns a top-N summary of self time by function and by file. start and stop each also take a Performance.getMetrics reading, so stop reports before/after/diff per metric (JSHeapUsedSize, Nodes, JSEventListeners, LayoutCount, RecalcStyleCount, cumulative Duration counters) — that is how you catch growth the CPU profile cannot see. action:"metrics" is just that reading, with no recording. On a minified production build pass sourceMap (the app.js.map of THAT build) to get readable names. The CPU profile works on the whole park (Profiler exists down to Chrome 38); metrics need Chromium 60+ (tizen55, pc) — on webOS 3 action:"metrics" fails with a clear message, while start/stop still return the profile with metrics:null and a warning.',
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				action: {type: 'string', enum: ['start', 'stop', 'metrics'], description: 'start a recording, stop it and get the result, or just read the metrics right now.'},
				samplingIntervalUs: {type: 'integer', minimum: 50, maximum: 1000000, description: 'start: sampling interval in microseconds (default 1000). Raise it (e.g. 4000) for long recordings on a weak TV, where sampling itself costs.'},
				path: {type: 'string', description: 'stop: where to write the .cpuprofile. Defaults to a scratch path.'},
				sourceMap: {type: 'string', description: 'stop: path to the .map of the build running on the device. Only the top-N frames are de-minified; a map that fails to load degrades to a warning.'},
				topN: {type: 'integer', minimum: 1, maximum: 200, description: 'stop: how many functions/files to report (default 20).'},
				collectGarbage: {type: 'boolean', description: 'Force a GC right before this reading (default false). Turn it on for leak hunting — on stop it makes the heap diff show what is really retained instead of garbage not collected yet. It costs a GC pause, which is why it is off by default inside a recording.'}
			},
			required: ['action']
		}
	},
	{
		name: 'tv_heap',
		description: 'Take a heap snapshot on the device and/or compare two of them — the tool for "the heap grew and never came back". Leak hunt: tv_heap action:"snapshot" (before) -> do the scenario (tv_press / tv_menu / tv_sequence) -> tv_heap action:"snapshot" (after) -> tv_heap action:"diff" with the two paths. A snapshot writes a .heapsnapshot file (open it in Chrome DevTools -> Memory -> Load) and returns the Summary view in numbers: total nodes and shallow size, how many DETACHED DOM nodes are still retained, and the top-N constructors by shallow size. diff returns the deltas — which constructors gained objects and bytes (topGrowth) and which lost them (topShrink), like the DevTools Comparison view. Retainer paths ("who holds this") and retained/dominator sizes are deliberately NOT computed: load the saved files in DevTools for those. A snapshot forces a full GC and pauses V8 for a long time (it can take a minute on a TV), so it is refused while a tv_profile recording is running. Needs the HeapProfiler domain — fine on tizen55/webos7/pc, best-effort on webOS 3. diff is a pure file operation: no device needed.',
		inputSchema: {
			type: 'object',
			properties: {
				...DEVICE_PROP,
				action: {type: 'string', enum: ['snapshot', 'diff'], description: 'snapshot: take one on the device. diff: compare two files already on disk.'},
				path: {type: 'string', description: 'snapshot: where to write the .heapsnapshot. Defaults to a scratch path.'},
				before: {type: 'string', description: 'diff: path to the earlier .heapsnapshot.'},
				after: {type: 'string', description: 'diff: path to the later .heapsnapshot.'},
				topN: {type: 'integer', minimum: 1, maximum: 200, description: 'How many constructors to report (default 20).'},
				timeoutMs: {type: 'integer', minimum: 5000, maximum: 600000, description: 'snapshot: give up after this long (default 120000 — a full heap off a slow TV legitimately takes tens of seconds).'}
			},
			required: ['action']
		}
	}
];

function textResult(obj) {
	const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
	return {content: [{type: 'text', text}]};
}

function errorResult(message) {
	return {content: [{type: 'text', text: 'ERROR: ' + message}], isError: true};
}

/**
 * Honest per-device reachability. The previous version searched the whole `sdb devices`
 * output for the word "device", which the header line "List of devices attached" always
 * satisfies — so every configured TV reported "connected".
 * @param {import('./config.js').DeviceConfig} cfg
 */
async function reachability(cfg) {
	try {
		if (cfg.platform === 'tizen') {
			const {stdout} = await execFileP('sdb', ['devices'], {timeout: 8000});
			const serial = `${cfg.host}:${cfg.sdbPort || 26101}`;
			const row = parseSdbDevices(stdout).find((d) => d.serial === serial);
			return row ? row.state : 'not-connected';
		}
		if (cfg.platform === 'webos') {
			const {stdout} = await execFileP('ares-device-info', cfg.device ? ['-d', cfg.device] : [], {timeout: 8000})
				.catch((e) => ({stdout: e.stdout || ''}));
			return stdout ? 'reachable' : 'unknown';
		}
		if (cfg.platform === 'pc') {
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 3000);
			try {
				const res = await fetch(cfg.url, {signal: ac.signal});
				return res.ok ? 'dev-server-up' : `dev-server-http-${res.status}`;
			} catch {
				return 'dev-server-down';
			} finally {
				clearTimeout(t);
			}
		}
		return 'n/a';
	} catch {
		return 'unreachable';
	}
}

const CONDITION_KEYS = ['focusText', 'selector', 'selectorGone', 'scene', 'text', 'expression', 'videoAdvancing', 'request'];

/**
 * tv_wait_for takes its condition as flat arguments (easier for a model than a nested
 * oneOf); fold exactly one of them into the condition object wait.js expects.
 */
function pickCondition(args) {
	const given = CONDITION_KEYS.filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== false);
	if (given.length === 0) {
		throw new Error(`give exactly one condition: ${CONDITION_KEYS.join(', ')}`);
	}
	if (given.length > 1) {
		throw new Error(`give exactly one condition, got ${given.join(' + ')}`);
	}
	return {[given[0]]: args[given[0]]};
}

async function handleCall(name, args) {
	switch (name) {
		case 'tv_devices': {
			const {devices, defaultDevice, path} = loadConfig();
			const rows = await Promise.all(devices.map(async (d) => ({
				id: d.id, platform: d.platform, name: d.name, engine: d.engine,
				appId: d.appId, target: d.host || d.device || d.url,
				status: await reachability(d),
				capabilities: deviceCapabilities(d),
				default: d.id === (defaultDevice || devices[0].id)
			})));
			return textResult({configPath: path, devices: rows});
		}
		case 'tv_install': {
			const s = sessionFor(args.device);
			const abs = resolve(args.path);
			const out = await s.adapter.install(abs, {appId: s.cfg.appId, uninstallFirst: !!args.uninstallFirst});
			return textResult({installed: abs, device: s.cfg.id, output: out.slice(-400)});
		}
		case 'tv_launch': {
			const s = sessionFor(args.device);
			const page = await s.ensureConnected({reload: !!args.reload, relaunch: !!args.relaunch, attach: !!args.attach});
			return textResult({device: s.cfg.id, engine: s.cfg.engine, attached: page});
		}
		case 'tv_press': {
			const s = sessionFor(args.device);
			const res = await s.press(args.key, {durationMs: args.durationMs, repeat: args.repeat, intervalMs: args.intervalMs});
			return textResult(res);
		}
		case 'tv_screenshot': {
			const s = sessionFor(args.device);
			const shot = await s.screenshot(args.timeoutMs || 6000);
			if (!shot.ok) {
				return textResult({ok: false, note: 'screenshot unavailable on this engine/frame (common on Tizen secure/overlay plane). Use tv_video_state and look at the physical TV.', reason: shot.reason});
			}
			const outPath = args.path
				? resolve(args.path)
				: resolve(process.env.TMPDIR || '/tmp', `tv-shot-${s.cfg.id}-${Date.now()}.png`);
			writeFileSync(outPath, shot.buffer);
			return textResult({ok: true, path: outPath, bytes: shot.buffer.length});
		}
		case 'tv_console': {
			const s = sessionFor(args.device);
			return textResult(s.consoleReport({filter: args.filter, levels: args.levels, limit: args.limit}));
		}
		case 'tv_network': {
			const s = sessionFor(args.device);
			const action = args.action || 'list';
			if (action === 'list') {
				return textResult(s.networkList({
					urlPattern: args.urlPattern, method: args.method, status: args.status, limit: args.limit
				}));
			}
			if (action === 'body') {
				return textResult(await s.networkBody(args.requestId));
			}
			if (action === 'curl') {
				return textResult(await s.networkCurl(args.requestId, {raw: !!args.raw}));
			}
			if (action === 'har') {
				// Only the path and the counts: a HAR with bodies is megabytes and belongs on disk.
				return textResult(await s.networkHar({
					path: args.path, urlPattern: args.urlPattern, method: args.method, status: args.status,
					withBodies: args.withBodies
				}));
			}
			if (action === 'mark') {
				return textResult(s.networkMark());
			}
			return errorResult(`tv_network needs action "list", "body", "curl", "har" or "mark", got ${JSON.stringify(args.action)}`);
		}
		case 'tv_video_state': {
			const s = sessionFor(args.device);
			return textResult(await s.videoState(args.sampleGapMs));
		}
		case 'tv_state': {
			const s = sessionFor(args.device);
			return textResult(await s.state());
		}
		case 'tv_wait_for': {
			const s = sessionFor(args.device);
			const condition = pickCondition(args);
			return textResult(await s.waitFor(condition, {
				timeoutMs: args.timeoutMs, intervalMs: args.intervalMs, stableMs: args.stableMs
			}));
		}
		case 'tv_goto': {
			const s = sessionFor(args.device);
			return textResult(await s.goto({
				direction: args.direction, text: args.text, selector: args.selector, testid: args.testid,
				maxSteps: args.maxSteps, deadlineMs: args.deadlineMs
			}));
		}
		case 'tv_menu': {
			const s = sessionFor(args.device);
			return textResult(await s.menu(args.item, {select: args.select, maxOpenPresses: args.maxOpenPresses}));
		}
		case 'tv_sequence': {
			const s = sessionFor(args.device);
			return textResult(await s.sequence(args.steps, {stopOnFail: args.stopOnFail}));
		}
		case 'tv_evaluate': {
			const s = sessionFor(args.device);
			const value = await s.evaluate(args.expression, args.awaitPromise);
			return textResult({value});
		}
		case 'tv_profile': {
			const s = sessionFor(args.device);
			if (args.action === 'start') {
				return textResult(await s.profileStart({
					samplingIntervalUs: args.samplingIntervalUs, collectGarbage: args.collectGarbage
				}));
			}
			if (args.action === 'stop') {
				// Deliberately only the file path + the summary: the raw profile is hundreds of
				// kilobytes of JSON and has no business in a tool response.
				return textResult(await s.profileStopAndSave({
					path: args.path, sourceMap: args.sourceMap, topN: args.topN, collectGarbage: args.collectGarbage
				}));
			}
			if (args.action === 'metrics') {
				return textResult(await s.metricsSnapshot({collectGarbage: args.collectGarbage}));
			}
			return errorResult(`tv_profile needs action "start", "stop" or "metrics", got ${JSON.stringify(args.action)}`);
		}
		case 'tv_heap': {
			if (args.action === 'snapshot') {
				const s = sessionFor(args.device);
				// Only the path and the summary: the snapshot itself is hundreds of megabytes.
				return textResult(await s.heapSnapshot({path: args.path, topN: args.topN, timeoutMs: args.timeoutMs}));
			}
			if (args.action === 'diff') {
				if (!args.before || !args.after) {
					return errorResult('tv_heap action:"diff" needs both `before` and `after` paths to .heapsnapshot files');
				}
				// No device on purpose: comparing two files must work with every TV switched off.
				return textResult(diffHeapSummaries(args.before, args.after, {topN: args.topN}));
			}
			return errorResult(`tv_heap needs action "snapshot" or "diff", got ${JSON.stringify(args.action)}`);
		}
		default:
			return errorResult(`unknown tool ${name}`);
	}
}

async function main() {
	// Fail loudly in the log if config is broken, but don't crash the server.
	try {
		loadConfig();
	} catch (e) {
		log('config warning:', e.message);
	}

	const server = new Server(
		{name: 'tv-debug-mcp', version: '0.2.0'},
		{capabilities: {tools: {}}}
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: TOOLS}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const {name, arguments: args = {}} = req.params;
		log(`call ${name} ${JSON.stringify(args)}`);
		try {
			return await handleCall(name, args);
		} catch (e) {
			log(`error in ${name}:`, e.message);
			return errorResult(e.message);
		}
	});

	const cleanup = async () => {
		for (const s of sessions.values()) {
			await s.dispose().catch(() => {});
		}
		process.exit(0);
	};
	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);
	// A rejected promise from fire-and-forget cleanup must not kill a long-lived stdio
	// server. Deliberately NOT catching uncaughtException: the sources we knew about
	// (socket `error` with no listener, spawn ENOENT) are fixed at the source, and a blanket
	// catch would hide a regression of exactly that bug.
	process.on('unhandledRejection', (e) => log('unhandledRejection:', (e && e.stack) || e));

	const transport = new StdioServerTransport();
	await server.connect(transport);
	log('tv-debug-mcp ready; known keys (tizen):', knownKeys('tizen').join(','));
}

main().catch((e) => {
	log('fatal:', e.stack || e.message);
	process.exit(1);
});
