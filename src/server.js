#!/usr/bin/env node
// tv-debug-mcp — MCP server for semi-manual QA runs on real Smart TVs over CDP.
//
// Tools: tv_devices, tv_install, tv_launch, tv_press, tv_screenshot, tv_console, tv_network,
// tv_video_state, tv_state, tv_snapshot, tv_record, tv_wait_for, tv_goto, tv_menu,
// tv_sequence, tv_evaluate, tv_profile, tv_heap.
// The park is described in devices.json (or TV_DEBUG_CONFIG) and can also contain a `pc`
// device — the same case run against a local Chrome. One persistent CDP session per device
// is kept across calls so console/exceptions accumulate from launch. All progress goes to
// stderr (stdout is the MCP stdio channel).
//
// A failing device must fail ONE tool call: everything below is wrapped so a dead TV,
// a missing sdb or a broken config never takes the stdio server down.

import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

import {loadConfig, getDevice} from './config.js';
import {DeviceSession, deviceCapabilities} from './session.js';
import {diffHeapSummaries} from './heap.js';
import {knownKeys} from './keymaps.js';
import {parseSdbDevices} from './adapters/tizen.js';
import {listDocResources, readDocResource, DOC_URI_PREFIX} from './tooldocs.js';
import {renderStateText, renderSnapshotText} from './render.js';
import {PKG_VERSION} from './version.js';

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
	device: {type: 'string'}
};

// Bounds are enforced by the handlers, not advertised: 18 tools × min/max was a kilobyte of schema.
const withDesc = (o, description) => (description ? {...o, description} : o);
const int = (min, max, description) => withDesc({type: 'integer'}, description);
const str = (description) => withDesc({type: 'string'}, description);
const bool = (description) => withDesc({type: 'boolean'}, description);
const en = (values, description) => withDesc({type: 'string', enum: values}, description);
const tool = (name, description, properties = {}, required = []) => ({
	name,
	description,
	inputSchema: {type: 'object', properties: {...DEVICE_PROP, ...properties}, ...(required.length ? {required} : {})}
});

/**
 * The tool list is sent to the model by every client, by some on every turn — it is kept to a
 * sentence or two per tool. The full reference (actions, step shapes, answer shapes) is an MCP
 * resource per tool: tv-debug://docs/<tool>.
 */
const TOOLS = [
	tool('tv_devices',
		'List configured TVs, reachability and what each supports. Start here.'),
	tool('tv_install',
		'Install a .wgt (Tizen) / .ipk (webOS) from an absolute path.',
		{path: str(''), uninstallFirst: bool('Uninstall first (cert mismatch).')},
		['path']),
	tool('tv_launch',
		'Debug-launch the app and attach over CDP (needed first). Default: kill, launch, wait for bootReady.',
		{
			reload: bool('Reload in place (keeps localStorage).'),
			relaunch: bool('Force kill + fresh launch.'),
			attach: bool('Reuse a running debug instance.'),
			waitBoot: bool('Wait for bootReady (default true).')
		}),
	tool('tv_press',
		'Send a remote key (UP/DOWN/LEFT/RIGHT/ENTER/BACK/… or a keyCode) and wait for the focus to settle.',
		{
			key: str('Key name or numeric keyCode.'),
			durationMs: int(0, 60000, 'Hold (long-press).'),
			repeat: int(1, 100, 'Press N times (default 1).'),
			intervalMs: int(0, 10000, 'Gap between repeats (default 250).'),
			settle: bool('false = no focus wait/read.')
		},
		['key']),
	tool('tv_screenshot',
		'Save a PNG of the frame (Tizen video plane often black/hangs; use tv_video_state for playback).',
		{path: str(''), timeoutMs: int(500, 60000, 'Default 6000.')}),
	tool('tv_console',
		'Console, exceptions, failed requests since launch, deduplicated with counts.',
		{
			filter: str('Substring on text / failed URLs.'),
			levels: {type: 'array', items: {type: 'string'}, description: 'log|info|debug|warning|error'},
			limit: int(1, 500, 'Per list (default 30).')
		}),
	tool('tv_network',
		'Request log since launch. Actions: list | body | curl | har | mark. Survives the app dying.',
		{
			action: en(['list', 'body', 'curl', 'har', 'mark'], ''),
			urlPattern: str('Substring or /regex/flags.'),
			method: str(''),
			status: {description: '"failed", a number, or {min,max}.'},
			limit: int(1, 500, 'Newest N (default 25).'),
			requestId: str('body/curl: id from list.'),
			raw: bool('curl: keep credentials.'),
			path: str('har: output path.'),
			withBodies: bool('har: include bodies (default true).')
		}),
	tool('tv_video_state',
		'Is playback advancing? Two currentTime samples of <video> (or webapis.avplay on old Tizen), readyState, size, src, error.',
		{sampleGapMs: int(100, 10000, 'Default 600.')}),
	tool('tv_state',
		'Read-only snapshot: url, scenes, focused element (text, path, index/total), popups, counts.',
		{format: en(['text', 'json'], 'Default text.')}),
	tool('tv_snapshot',
		'Rows around the focus with refs (e1, e2…) for tv_goto {ref} and neighbours per direction. Refs expire on the next snapshot/navigation/60s.',
		{
			detail: en(['focus', 'rows', 'full'], 'Default rows; full = no viewport filter.'),
			maxRows: int(1, 40, 'Default 6.'),
			maxItemsPerRow: int(1, 60, 'Default 12.'),
			release: bool('Drop the refs now.'),
			format: en(['text', 'json'], 'Default text.')
		}),
	tool('tv_record',
		'Record the PHYSICAL remote into a tv_sequence: start (relaunch, ● REC), stop (compile + return, no write), write (after human approval).',
		{
			action: en(['start', 'stop', 'status', 'write'], ''),
			title: str(''),
			path: str(''),
			overwrite: bool('write: replace existing.'),
			note: str(''),
			steps: {type: 'array', description: 'write: edited steps.'},
			relaunch: bool('start: default true.'),
			assert: en(['minimal', 'normal', 'rich'], 'Default normal.'),
			longPressMs: int(200, 10000, 'Default 700.'),
			collapse: bool('Runs into goto (default true).'),
			heartbeatMs: int(250, 10000, 'Default 1000.'),
			overlay: bool('REC badge (default true).')
		}),
	tool('tv_wait_for',
		'Wait for exactly one condition instead of sleeping. element/elementGone/sceneName take names from the app profile.',
		{
			focusText: str('Focused text contains.'),
			element: str('Visible profile element NAME.'),
			elementGone: str('No visible profile element NAME.'),
			sceneName: str('Visible profile scene NAME.'),
			selector: str('Visible CSS match.'),
			selectorGone: str('No visible CSS match.'),
			scene: str('Visible scene class contains.'),
			text: str('Page text contains.'),
			expression: str('Truthy ES5 expression.'),
			videoAdvancing: bool('Playback is moving.'),
			request: {type: 'object', description: '{urlPattern, method, bodyContains, status, statusMin/Max, absent, count}.'},
			timeoutMs: int(100, 300000, 'Default 15000.'),
			intervalMs: int(50, 5000, 'Default 250.'),
			stableMs: int(0, 10000, 'Keep holding this long.'),
			withState: bool('Append tv_state.')
		}),
	tool('tv_goto',
		'Press a direction until the FOCUSED element matches the target (ref | element | text | selector | testid); stops at edges/wrap-around. select:true = ENTER on arrival.',
		{
			direction: en(['UP', 'DOWN', 'LEFT', 'RIGHT'], 'Direction to travel.'),
			ref: str('tv_snapshot ref.'),
			element: str('Profile element NAME.'),
			text: str('Focused text contains.'),
			selector: str('Focused element CSS.'),
			testid: str('Focused data-testid.'),
			select: bool('ENTER on arrival.'),
			maxSteps: int(1, 200, 'Default 30.'),
			deadlineMs: int(1000, 300000, 'Default 45000.')
		},
		['direction']),
	tool('tv_menu',
		'Open the app menu (profile menu block) and pick a section by name; without item, open and list sections.',
		{
			item: str('Section title (substring).'),
			select: bool('ENTER on the item (default true).'),
			maxOpenPresses: int(1, 50, 'Default 20.')
		}),
	tool('tv_sequence',
		'Run a whole case in one call under the device lock. Steps (one key each): launch, press, longpress, goto, menu, wait, expect, expectRequest, networkMark, eval, sleep, videoState, state, snapshot, profileStart, profileStop, metrics — see tv-debug://docs/tv_sequence.',
		{
			steps: {type: 'array', items: {type: 'object'}},
			stopOnFail: bool('Default true.'),
			report: en(['compact', 'full'], 'full: every step result.')
		},
		['steps']),
	tool('tv_evaluate',
		'Run JS in the page (ES5 on old TVs) and return the value, capped at 16 KB.',
		{expression: str(''), awaitPromise: bool('Default true.')},
		['expression']),
	tool('tv_profile',
		'CPU profile: start, act, stop (.cpuprofile + top functions + metrics diff); action metrics = one reading.',
		{
			action: en(['start', 'stop', 'metrics'], ''),
			samplingIntervalUs: int(50, 1000000, 'start: default 1000.'),
			path: str('stop: .cpuprofile path.'),
			sourceMap: str('stop: .map of the build.'),
			topN: int(1, 200, 'stop: default 20.'),
			collectGarbage: bool('GC first.')
		},
		['action']),
	tool('tv_heap',
		'Heap snapshot file + constructor summary + detached nodes; action diff compares two files.',
		{
			action: en(['snapshot', 'diff'], ''),
			path: str('snapshot: output path.'),
			before: str('diff: earlier file.'),
			after: str('diff: later file.'),
			topN: int(1, 200, 'Default 20.'),
			timeoutMs: int(5000, 600000, 'Default 120000.')
		},
		['action'])
];

function textResult(obj) {
	// No pretty-printing: the indentation was a quarter of every answer.
	const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
	return {content: [{type: 'text', text}]};
}

function errorResult(message) {
	return {content: [{type: 'text', text: 'ERROR: ' + message}], isError: true};
}

/** tv_devices answers are cached this long: a reachability probe per device is 3-8s of CLI. */
const REACH_CACHE_MS = 5000;
/** @type {Map<string, {at: number, status: string}>} */
const reachCache = new Map();

/**
 * Honest per-device reachability. The previous version searched the whole `sdb devices`
 * output for the word "device", which the header line "List of devices attached" always
 * satisfies — so every configured TV reported "connected".
 * @param {import('./config.js').DeviceConfig} cfg
 * @param {{sdbRows: ?Promise<Array<object>>}} shared one `sdb devices` for the whole park
 */
async function reachability(cfg, shared) {
	try {
		if (cfg.platform === 'tizen') {
			const rows = await shared.sdbRows;
			const serial = `${cfg.host}:${cfg.sdbPort || 26101}`;
			const row = rows.find((d) => d.serial === serial);
			return row ? row.state : 'not-connected';
		}
		if (cfg.platform === 'webos') {
			const {stdout} = await execFileP('ares-device-info', cfg.device ? ['-d', cfg.device] : [], {timeout: 3000})
				.catch((e) => ({stdout: e.stdout || ''}));
			return stdout ? 'reachable' : 'unknown';
		}
		if (cfg.platform === 'vidaa') {
			// Attach-only platform: reachable ⇔ the on-TV inspector answers /json/version.
			const ac = new AbortController();
			const t = setTimeout(() => ac.abort(), 3000);
			try {
				const res = await fetch(`http://${cfg.host}:${cfg.port || 9226}/json/version`, {signal: ac.signal});
				return res.ok ? 'online' : `inspector-http-${res.status}`;
			} catch {
				return 'offline';
			} finally {
				clearTimeout(t);
			}
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

/**
 * Reachability of the whole park: one `sdb devices` shared by every Tizen entry, every device
 * probed in parallel, answers cached for a few seconds.
 * @param {Array<import('./config.js').DeviceConfig>} devices
 * @return {Promise<Map<string, string>>}
 */
async function reachabilityAll(devices) {
	const now = Date.now();
	const out = new Map();
	const todo = devices.filter((d) => {
		const hit = reachCache.get(d.id);
		if (hit && now - hit.at < REACH_CACHE_MS) {
			out.set(d.id, hit.status);
			return false;
		}
		return true;
	});
	const shared = {
		sdbRows: todo.some((d) => d.platform === 'tizen')
			? execFileP('sdb', ['devices'], {timeout: 8000})
				.then(({stdout}) => parseSdbDevices(stdout))
				.catch(() => [])
			: null
	};
	await Promise.all(todo.map(async (d) => {
		const status = await reachability(d, shared);
		reachCache.set(d.id, {at: Date.now(), status});
		out.set(d.id, status);
	}));
	return out;
}

const CONDITION_KEYS = [
	'focusText', 'element', 'elementGone', 'sceneName',
	'selector', 'selectorGone', 'scene', 'text', 'expression', 'videoAdvancing', 'request'
];

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
			const status = await reachabilityAll(devices);
			const rows = devices.map((d) => ({
				id: d.id, platform: d.platform, name: d.name, engine: d.engine,
				appId: d.appId, target: d.host || d.device || d.url,
				status: status.get(d.id),
				capabilities: deviceCapabilities(d),
				default: d.id === (defaultDevice || devices[0].id)
			}));
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
			const page = await s.ensureConnected({
				reload: !!args.reload, relaunch: !!args.relaunch, attach: !!args.attach,
				waitBoot: args.waitBoot
			});
			return textResult(s.launchReport(page));
		}
		case 'tv_press': {
			const s = sessionFor(args.device);
			const res = await s.press(args.key, {
				durationMs: args.durationMs, repeat: args.repeat, intervalMs: args.intervalMs, settle: args.settle
			});
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
			const st = await s.state();
			return textResult(args.format === 'json' ? st : renderStateText(st));
		}
		case 'tv_record': {
			const s = sessionFor(args.device);
			const action = args.action || 'start';
			if (action === 'start') {
				return textResult(await s.recordStart({
					assert: args.assert, longPressMs: args.longPressMs, collapse: args.collapse,
					heartbeatMs: args.heartbeatMs, overlay: args.overlay, relaunch: args.relaunch
				}));
			}
			if (action === 'status') {
				return textResult(await s.recordStatus());
			}
			if (action === 'stop') {
				return textResult(await s.recordStop({
					title: args.title, path: args.path, overwrite: !!args.overwrite, note: args.note,
					assert: args.assert, longPressMs: args.longPressMs, collapse: args.collapse
				}));
			}
			if (action === 'write') {
				return textResult(s.recordWrite({
					path: args.path, overwrite: !!args.overwrite, title: args.title,
					note: args.note, steps: args.steps
				}));
			}
			return errorResult(`tv_record needs action "start", "stop", "status" or "write", got ${JSON.stringify(args.action)}`);
		}
		case 'tv_snapshot': {
			const s = sessionFor(args.device);
			const snap = await s.snapshot({
				detail: args.detail, maxRows: args.maxRows, maxItemsPerRow: args.maxItemsPerRow,
				release: !!args.release
			});
			return textResult(args.format === 'json' ? snap : renderSnapshotText(snap));
		}
		case 'tv_wait_for': {
			const s = sessionFor(args.device);
			const condition = pickCondition(args);
			return textResult(await s.waitFor(condition, {
				timeoutMs: args.timeoutMs, intervalMs: args.intervalMs, stableMs: args.stableMs, withState: !!args.withState
			}));
		}
		case 'tv_goto': {
			const s = sessionFor(args.device);
			return textResult(await s.goto({
				direction: args.direction, element: args.element, ref: args.ref,
				text: args.text, selector: args.selector, testid: args.testid,
				select: args.select, maxSteps: args.maxSteps, deadlineMs: args.deadlineMs
			}));
		}
		case 'tv_menu': {
			const s = sessionFor(args.device);
			return textResult(await s.menu(args.item, {select: args.select, maxOpenPresses: args.maxOpenPresses}));
		}
		case 'tv_sequence': {
			const s = sessionFor(args.device);
			return textResult(await s.sequence(args.steps, {stopOnFail: args.stopOnFail, report: args.report}));
		}
		case 'tv_evaluate': {
			const s = sessionFor(args.device);
			return textResult(await s.evaluateCapped(args.expression, args.awaitPromise));
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
		{name: 'tv-debug-mcp', version: PKG_VERSION},
		{capabilities: {tools: {}, resources: {}}}
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: TOOLS}));
	// The long-form reference lives here, not in the tool descriptions: read once when needed
	// instead of being re-sent with every turn.
	server.setRequestHandler(ListResourcesRequestSchema, async () => ({resources: listDocResources()}));
	server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
		const uri = req.params.uri;
		const text = readDocResource(uri);
		if (text === null) {
			throw new Error(`unknown resource ${uri} — the tool references are ${DOC_URI_PREFIX}<tool>`);
		}
		return {contents: [{uri, mimeType: 'text/markdown', text}]};
	});

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
