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
 * @typedef {{selector?: string, text?: string, testid?: string}} ElementSpec
 */

/**
 * @typedef {{
 *   id: string,
 *   focus: Array<string>,
 *   scene: {container: string, strip?: string},
 *   popup: Array<string>,
 *   menu: ?{openKey: string, root: string, item: string, title?: string, secondLevel?: string},
 *   tile: ?string,
 *   bootReady: ?{selector?: string, scene?: string, timeoutMs?: number},
 *   elements: Object<string, (string|ElementSpec)>,
 *   scenes: Object<string, string>,
 *   snapshot: ?{row?: string, item?: string, label?: string, maxRows?: number, maxItemsPerRow?: number},
 *   record: ?{watch?: Array<{urlPattern: string, method?: string, name?: string}>},
 *   settle: ?{quietMs?: number, changeTimeoutMs?: number}
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
	bootReady: null,
	// A registry of names the case author writes instead of raw CSS. Empty by default: a
	// profile without it keeps working, only the `element` forms are unavailable.
	elements: {},
	scenes: {},
	snapshot: null,
	record: null,
	// Press settle thresholds: how long the focus must stay put after a press (quietMs) and how
	// long to wait for it to move at all (changeTimeoutMs). Platform defaults apply when absent.
	settle: null
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
		popup: json.popup && json.popup.length ? json.popup : GENERIC.popup,
		// Per-key merge, unlike focus/popup above: those are "a non-empty list wins outright",
		// because a half-overridden focus selector list is a broken profile. A name registry is
		// additive by nature — a profile that defines one element must not lose the rest.
		elements: {...GENERIC.elements, ...(json.elements || {})},
		scenes: {...GENERIC.scenes, ...(json.scenes || {})}
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

// ---------------------------------------------------------------------------------------
// Named elements and scenes.
//
// A case that says {"element": "catalog.tile"} survives a markup change; one that says
// ".video-tile--v2" does not, and the same selector is copy-pasted into a dozen case files.
// The registry lives in the profile, so the fix is one line in one JSON.
//
// Every resolution is echoed back to the caller as `resolvedFrom` — a red case has to be
// able to say WHICH selector was actually checked, otherwise the indirection costs more
// debugging than it saves. And an unknown name fails loudly with the list of known ones,
// the same contract requireMenu has: a typo must never degrade into "nothing matched".
// ---------------------------------------------------------------------------------------

/**
 * @param {AppProfile} profile
 * @param {string} kind 'element' | 'scene'
 * @return {string}
 */
function knownList(profile, kind) {
	const map = kind === 'scene' ? profile.scenes : profile.elements;
	const names = Object.keys(map || {}).sort();
	if (!names.length) {
		return `app profile "${profile.id}" defines no ${kind}s — add a "${kind === 'scene' ? 'scenes' : 'elements'}" block to apps/${profile.id}.json`;
	}
	return `known ${kind}s in "${profile.id}": ${names.join(', ')}`;
}

/**
 * Look a named element up in the profile registry.
 * @param {AppProfile} profile
 * @param {string} name
 * @return {ElementSpec}
 */
export function resolveElement(profile, name) {
	const raw = profile.elements ? profile.elements[name] : undefined;
	if (raw === undefined || raw === null) {
		throw new Error(`unknown element "${name}" — ${knownList(profile, 'element')}`);
	}
	const spec = typeof raw === 'string' ? {selector: raw} : {...raw};
	if (spec.selector == null && spec.testid == null && spec.text == null) {
		throw new Error(
			`element "${name}" in app profile "${profile.id}" is empty — it needs at least one of ` +
			'selector, testid, text (a bare string is a shorthand for selector)'
		);
	}
	return spec;
}

/**
 * Look a named scene up in the profile registry.
 * @param {AppProfile} profile
 * @param {string} name
 * @return {string}
 */
export function resolveScene(profile, name) {
	const raw = profile.scenes ? profile.scenes[name] : undefined;
	if (raw === undefined || raw === null || raw === '') {
		throw new Error(`unknown scene "${name}" — ${knownList(profile, 'scene')}`);
	}
	return String(raw);
}

/**
 * Fold a `{element: "name"}` target into the flat {text, selector, testid} tv_goto matches on.
 * A raw target passes through untouched, so tv_menu and existing cases are unaffected.
 * @param {AppProfile} profile
 * @param {{element?: string, text?: string, selector?: string, testid?: string}} target
 * @return {{target: {text: ?string, selector: ?string, testid: ?string}, resolvedFrom: ?object}}
 */
export function resolveTarget(profile, target) {
	const t = target || {};
	if (t.element == null) {
		return {target: {text: t.text, selector: t.selector, testid: t.testid}, resolvedFrom: null};
	}
	const spec = resolveElement(profile, t.element);
	// An explicit field on the call wins over the registry: the name gives the shape, the
	// call narrows it ({"element":"catalog.tile","text":"Trailer"}).
	const merged = {
		text: t.text != null ? t.text : spec.text,
		selector: t.selector != null ? t.selector : spec.selector,
		testid: t.testid != null ? t.testid : spec.testid
	};
	return {target: merged, resolvedFrom: {element: t.element, ...stripNull(merged)}};
}

/**
 * Map the name-based wait conditions onto the raw ones wait.js understands:
 *   {element}     -> {selector} (+ withText when the element is also qualified by text)
 *   {elementGone} -> {selectorGone}
 *   {sceneName}   -> {scene}
 * @param {AppProfile} profile
 * @param {object} cond
 * @return {{condition: object, resolvedFrom: ?object}}
 */
export function resolveCondition(profile, cond) {
	const c = cond || {};
	if (c.sceneName != null) {
		const scene = resolveScene(profile, c.sceneName);
		return {condition: {scene}, resolvedFrom: {sceneName: c.sceneName, scene}};
	}
	const name = c.element != null ? c.element : c.elementGone;
	if (name == null) {
		return {condition: c, resolvedFrom: null};
	}
	const gone = c.elementGone != null;
	const spec = resolveElement(profile, name);
	const selector = elementSelector(profile, name, spec);
	const condition = gone ? {selectorGone: selector} : {selector};
	// A text qualifier must not be dropped silently — an element defined as "this selector,
	// with this text" that degrades to "this selector" is an assertion that passes on the
	// wrong node. wait.js honours `withText` on both selector forms.
	if (spec.text != null) {
		condition.withText = String(spec.text);
	}
	return {
		condition,
		resolvedFrom: {[gone ? 'elementGone' : 'element']: name, selector, ...(spec.text != null ? {withText: spec.text} : {})}
	};
}

/**
 * A CSS selector for an element spec. Text alone cannot become one — say so instead of
 * matching everything.
 * @param {AppProfile} profile
 * @param {string} name
 * @param {ElementSpec} spec
 * @return {string}
 */
function elementSelector(profile, name, spec) {
	if (spec.selector != null) {
		return String(spec.selector);
	}
	if (spec.testid != null) {
		const id = String(spec.testid).replace(/["\\]/g, '\\$&');
		return `[data-testid="${id}"], [data-export-id="${id}"]`;
	}
	throw new Error(
		`element "${name}" in app profile "${profile.id}" is defined by text only, so it has no CSS ` +
		'selector — a wait condition needs one. Use focusText for a text-only check, or add a selector.'
	);
}

/**
 * @param {object} o
 * @return {object} same object without null/undefined values
 */
function stripNull(o) {
	const out = {};
	for (const k of Object.keys(o)) {
		if (o[k] !== null && o[k] !== undefined) {
			out[k] = o[k];
		}
	}
	return out;
}
