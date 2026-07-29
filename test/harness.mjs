// Shared stdio JSON-RPC harness for the acceptance scripts.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

import {getDevice} from '../src/config.js';
import {loadAppProfile} from '../src/appprofile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const serverPath = join(__dirname, '..', 'src', 'server.js');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What the on-device checks need to know about the app under test, read from its profile
 * instead of being hardcoded to one product. Everything comes from `apps/<app>.json`; the
 * optional `checks` block covers what the profile does not already express:
 *
 *   "checks": {"homeSection": "Main", "popup": "[class*=context-menu]"}
 *
 * @param {string} [deviceId] defaults to the device config's defaultDevice
 * @return {{app: string, tile: string, popup: ?string, homeSection: ?string, bootTimeoutMs: number}}
 */
export function appTargets(deviceId) {
	const dev = getDevice(deviceId);
	const profile = loadAppProfile(dev.app);
	const checks = profile.checks || {};
	const tile = checks.tile || profile.bootReady?.selector || profile.tile;
	if (!tile) {
		throw new Error(
			`device "${dev.id}" has no tile selector to check against: give it "app": "<id>" in devices.json ` +
			`and a "tile" (or "checks.tile") in apps/<id>.json.`
		);
	}
	return {
		app: profile.id,
		tile,
		popup: checks.popup || null,
		homeSection: checks.homeSection || null,
		bootTimeoutMs: profile.bootReady?.timeoutMs || 60000
	};
}

export function makeChecker() {
	const state = {passed: 0, failed: 0};
	const check = (name, ok, detail) => {
		if (ok) {
			state.passed++;
			console.log(`  PASS  ${name}`);
		} else {
			state.failed++;
			console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
		}
		return !!ok;
	};
	check.summary = () => {
		console.log(`\n${state.passed} passed, ${state.failed} failed\n`);
		return state.failed;
	};
	return check;
}

/**
 * @param {string} label prefix for the server's stderr lines ('' to hide them)
 * @param {object} [env]
 */
export function startServer(label = 'srv', env = {}) {
	const child = spawn('node', [serverPath], {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, ...env}});
	if (label) {
		child.stderr.on('data', (c) => {
			const s = c.toString().trim();
			if (s) {
				console.log(`    [${label}] ${s.split('\n').join(`\n    [${label}] `)}`);
			}
		});
	} else {
		child.stderr.resume();
	}

	let id = 0;
	let buf = '';
	const pending = new Map();
	child.stdout.on('data', (chunk) => {
		buf += chunk.toString();
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) {
				continue;
			}
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.id && pending.has(msg.id)) {
				pending.get(msg.id)(msg);
				pending.delete(msg.id);
			}
		}
	});

	const rpc = (method, params) => new Promise((res) => {
		const myId = ++id;
		pending.set(myId, res);
		child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: myId, method, params}) + '\n');
	});

	const call = async (name, args = {}) => {
		const r = await rpc('tools/call', {name, arguments: args});
		const text = r.result?.content?.[0]?.text;
		if (r.result?.isError) {
			return {__error: text};
		}
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	};

	const ready = (async () => {
		await sleep(400);
		await rpc('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: label || 'test', version: '0'}});
		child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
	})();

	return {child, rpc, call, ready, alive: () => child.exitCode === null, stop: () => child.kill('SIGTERM')};
}
