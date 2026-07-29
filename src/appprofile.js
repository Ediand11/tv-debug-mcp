// App profiles: everything the navigation tools need to know about the app under test.
//
// This is the seam that keeps the MCP app-agnostic. `tv_goto` / `tv_menu` / `tv_state` need
// to know which class marks focus, what a scene looks like, where the menu lives — and that
// is per-app knowledge, not per-platform. Putting it in `apps/<id>.json` means the Solid
// smarttv stack (different focus marker, different menu) is a second file, not a fork.
//
// A device opts in with `"app": "<id>"` in devices.json. Without it, generic defaults apply
// and text-matching navigation still works — only menu-aware helpers need a profile.

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, isAbsolute, resolve} from 'node:path';

import {DEFAULT_FOCUS_SELECTORS} from './inject.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {{
 *   id: string,
 *   focus: Array<string>,
 *   scene: {container: string, strip?: string},
 *   popup: Array<string>,
 *   menu: ?{openKey: string, root: string, item: string, title?: string, secondLevel?: string},
 *   tile: ?string,
 *   bootReady: ?{selector?: string, scene?: string, timeoutMs?: number}
 * }} AppProfile
 */

/** @type {AppProfile} */
const GENERIC = {
	id: 'generic',
	focus: DEFAULT_FOCUS_SELECTORS,
	scene: {container: '._scene, [data-scene], .scene'},
	popup: ['[class*=popup]', '[class*=modal]', '[class*=overlay]', '[role=dialog]'],
	menu: null,
	tile: null,
	bootReady: null
};

const _cache = new Map();

/**
 * @param {?string} appId value of the device's `app` field
 * @return {AppProfile}
 */
export function loadAppProfile(appId) {
	if (!appId) {
		return GENERIC;
	}
	if (_cache.has(appId)) {
		return _cache.get(appId);
	}
	const path = isAbsolute(appId) || appId.endsWith('.json')
		? resolve(appId)
		: join(__dirname, '..', 'apps', `${appId}.json`);
	let json;
	try {
		json = JSON.parse(readFileSync(path, 'utf8'));
	} catch (e) {
		throw new Error(`cannot load app profile "${appId}" (${path}): ${e.message}`);
	}
	const profile = {
		...GENERIC,
		...json,
		focus: json.focus && json.focus.length ? json.focus : GENERIC.focus,
		scene: {...GENERIC.scene, ...(json.scene || {})},
		popup: json.popup && json.popup.length ? json.popup : GENERIC.popup
	};
	_cache.set(appId, profile);
	return profile;
}

/**
 * @param {AppProfile} profile
 * @return {{openKey: string, root: string, item: string, title?: string, secondLevel?: string}}
 */
export function requireMenu(profile) {
	if (!profile.menu) {
		throw new Error(
			`app profile "${profile.id}" has no "menu" section — tv_menu needs one ` +
			'(openKey / root / item selectors). Add it to apps/<app>.json, or navigate with tv_goto.'
		);
	}
	return profile.menu;
}
