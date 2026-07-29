// Device registry loader. The park of TVs (and the laptop browser) is described in a JSON
// file — by default devices.json next to the package, overridable with TV_DEBUG_CONFIG.
// No device-manager service (rtv) yet; the MCP talks to sdb/ares/Chrome directly.
//
// The file is re-read when its mtime changes, so editing the park does not need an MCP
// restart, and it is validated before anything uses it: duplicate ids used to silently
// share one session, and duplicate local ports silently cross-wired two TVs.

import {readFileSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PLATFORMS = ['tizen', 'webos', 'pc'];

/**
 * @typedef {{
 *   id: string,
 *   platform: 'tizen'|'webos'|'pc',
 *   name?: string,
 *   engine?: string,
 *   app?: string,
 *   appId?: string,
 *   host?: string,
 *   sdbPort?: number,
 *   cliTarget?: string,
 *   device?: string,
 *   url?: string,
 *   chromePath?: string,
 *   chromeArgs?: Array<string>,
 *   inputMode?: 'trusted'|'synthetic',
 *   localPort?: number
 * }} DeviceConfig
 */

/** @type {?{devices: Array<DeviceConfig>, defaultDevice?: string, path: string, mtimeMs: number}} */
let _cache = null;

function configPath() {
	return process.env.TV_DEBUG_CONFIG
		? resolve(process.env.TV_DEBUG_CONFIG)
		: join(__dirname, '..', 'devices.json');
}

/**
 * @param {Array<DeviceConfig>} devices
 * @param {string} path
 * @param {string} [defaultDevice]
 */
function validate(devices, path, defaultDevice) {
	if (!devices.length) {
		throw new Error(`no devices configured in ${path}`);
	}
	const seenIds = new Set();
	const seenPorts = new Map();
	for (const d of devices) {
		if (!d.id) {
			throw new Error(`${path}: every device needs an "id"`);
		}
		if (seenIds.has(d.id)) {
			throw new Error(`${path}: duplicate device id "${d.id}" — ids must be unique`);
		}
		seenIds.add(d.id);

		if (!PLATFORMS.includes(d.platform)) {
			throw new Error(`${path}: device "${d.id}" has platform "${d.platform}"; expected one of ${PLATFORMS.join(', ')}`);
		}
		if (d.platform === 'tizen' && !d.host) {
			throw new Error(`${path}: tizen device "${d.id}" needs "host" (the TV's IP)`);
		}
		if ((d.platform === 'tizen' || d.platform === 'webos') && !d.appId) {
			throw new Error(`${path}: ${d.platform} device "${d.id}" needs "appId"`);
		}
		if (d.platform === 'pc' && !d.url) {
			throw new Error(`${path}: pc device "${d.id}" needs "url" (e.g. http://localhost:1337)`);
		}
		if (d.inputMode && d.inputMode !== 'trusted' && d.inputMode !== 'synthetic') {
			throw new Error(`${path}: device "${d.id}" has inputMode "${d.inputMode}"; expected "trusted" or "synthetic"`);
		}
		if (d.localPort) {
			if (seenPorts.has(d.localPort)) {
				throw new Error(
					`${path}: devices "${seenPorts.get(d.localPort)}" and "${d.id}" both pin localPort ${d.localPort} — they would cross-wire`
				);
			}
			seenPorts.set(d.localPort, d.id);
		}
	}
	if (defaultDevice && !seenIds.has(defaultDevice)) {
		throw new Error(`${path}: defaultDevice "${defaultDevice}" is not among ${[...seenIds].join(', ')}`);
	}
}

/**
 * @param {{force?: boolean}} [opts]
 * @return {{devices: Array<DeviceConfig>, defaultDevice?: string, path: string, mtimeMs: number}}
 */
export function loadConfig(opts = {}) {
	const path = configPath();
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch (e) {
		throw new Error(`cannot read device config at ${path}: ${e.message}. Set TV_DEBUG_CONFIG or create devices.json.`);
	}
	if (_cache && _cache.path === path && _cache.mtimeMs === mtimeMs && !opts.force) {
		return _cache;
	}

	let json;
	try {
		json = JSON.parse(readFileSync(path, 'utf8'));
	} catch (e) {
		throw new Error(`device config ${path} is not valid JSON: ${e.message}`);
	}
	const devices = Array.isArray(json.devices) ? json.devices : [];
	validate(devices, path, json.defaultDevice);

	_cache = {devices, defaultDevice: json.defaultDevice, path, mtimeMs};
	return _cache;
}

/**
 * @param {string} [id]
 * @return {DeviceConfig}
 */
export function getDevice(id) {
	const {devices, defaultDevice} = loadConfig();
	const wanted = id || defaultDevice || devices[0].id;
	const dev = devices.find((d) => d.id === wanted);
	if (!dev) {
		throw new Error(`device "${wanted}" not found. Known: ${devices.map((d) => d.id).join(', ')}`);
	}
	return dev;
}
