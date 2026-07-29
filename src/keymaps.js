// Platform key maps: logical key name -> a descriptor of the key event to produce.
//
// The TV apps we drive listen for a `keydown` on `document` and look the event up by
// `event.keyCode`. So a synthetic KeyboardEvent carrying the right keyCode drives
// navigation exactly like the remote.
//
// A bare number is not enough any more: the browser adapter dispatches TRUSTED events via
// `Input.dispatchKeyEvent`, which wants the DOM `key` and `code` alongside the legacy
// virtual key code. Hence KeySpec {code, key, domCode} instead of a plain integer.
//
// Tizen values come verbatim from the platform's own input layer (`TvKeyCode`), webOS from
// its equivalent. Where a platform has no dedicated code we fall back to the shared
// d-pad/enter codes, which every TV browser emits.

/** @typedef {{code: number, key: string, domCode: string}} KeySpec */
/** @typedef {{[name: string]: KeySpec}} KeyMap */

/**
 * @param {number} code
 * @param {string} [key]
 * @param {string} [domCode]
 * @return {KeySpec}
 */
const k = (code, key = '', domCode = '') => ({code, key, domCode});

/** @type {KeyMap} */
const DPAD = {
	LEFT: k(37, 'ArrowLeft', 'ArrowLeft'),
	UP: k(38, 'ArrowUp', 'ArrowUp'),
	RIGHT: k(39, 'ArrowRight', 'ArrowRight'),
	DOWN: k(40, 'ArrowDown', 'ArrowDown'),
	ENTER: k(13, 'Enter', 'Enter'),
	DIGIT_0: k(48, '0', 'Digit0'),
	DIGIT_1: k(49, '1', 'Digit1'),
	DIGIT_2: k(50, '2', 'Digit2'),
	DIGIT_3: k(51, '3', 'Digit3'),
	DIGIT_4: k(52, '4', 'Digit4'),
	DIGIT_5: k(53, '5', 'Digit5'),
	DIGIT_6: k(54, '6', 'Digit6'),
	DIGIT_7: k(55, '7', 'Digit7'),
	DIGIT_8: k(56, '8', 'Digit8'),
	DIGIT_9: k(57, '9', 'Digit9')
};

/** @type {KeyMap} */
const TIZEN = {
	...DPAD,
	BACK: k(10009, 'XF86Back'),
	// KEY_MENU and KEY_INFO really are the same code upstream — not a typo here.
	MENU: k(457, 'ContextMenu'),
	INFO: k(457, 'Info'),
	GUIDE: k(458, 'Guide'),
	SEARCH: k(10225, 'BrowserSearch'),
	TOOLS: k(10135, 'Tools'),
	CAPTION: k(10221, 'ClosedCaptionToggle'),
	RED: k(403, 'ColorF0Red'),
	GREEN: k(404, 'ColorF1Green'),
	YELLOW: k(405, 'ColorF2Yellow'),
	BLUE: k(406, 'ColorF3Blue'),
	PLAY: k(415, 'MediaPlay'),
	PAUSE: k(19, 'MediaPause', 'Pause'),
	PLAY_PAUSE: k(10252, 'MediaPlayPause'),
	STOP: k(413, 'MediaStop'),
	REWIND: k(412, 'MediaRewind'),
	FAST_FORWARD: k(417, 'MediaFastForward'),
	TRACK_NEXT: k(10233, 'MediaTrackNext'),
	TRACK_PREV: k(10232, 'MediaTrackPrevious'),
	RECORD: k(416, 'MediaRecord'),
	CHANNEL_UP: k(427, 'ChannelUp'),
	CHANNEL_DOWN: k(428, 'ChannelDown'),
	VOLUME_UP: k(447, 'AudioVolumeUp'),
	VOLUME_DOWN: k(448, 'AudioVolumeDown'),
	VOLUME_MUTE: k(449, 'AudioVolumeMute'),
	EXIT: k(10182, 'Exit')
};

/** @type {KeyMap} */
const WEBOS = {
	...DPAD,
	BACK: k(461, 'XF86Back'),
	MENU: k(1056, 'ContextMenu'),
	INFO: k(457, 'Info'),
	RED: k(403, 'ColorF0Red'),
	GREEN: k(404, 'ColorF1Green'),
	YELLOW: k(405, 'ColorF2Yellow'),
	BLUE: k(406, 'ColorF3Blue'),
	PLAY: k(415, 'MediaPlay'),
	PAUSE: k(19, 'MediaPause', 'Pause'),
	STOP: k(413, 'MediaStop'),
	REWIND: k(412, 'MediaRewind'),
	FAST_FORWARD: k(417, 'MediaFastForward'),
	// The app maps 33/34 to PAGE_UP/PAGE_DOWN, not to channel keys — and those are exactly
	// the fast-scroll keys for long lists. CHANNEL_* kept as aliases for muscle memory.
	PAGE_UP: k(33, 'PageUp', 'PageUp'),
	PAGE_DOWN: k(34, 'PageDown', 'PageDown'),
	CHANNEL_UP: k(33, 'PageUp', 'PageUp'),
	CHANNEL_DOWN: k(34, 'PageDown', 'PageDown')
};

// The PC/dev build runs in a plain Chrome, so only keys a desktop keyboard can produce.
/** @type {KeyMap} */
const PC = {
	...DPAD,
	BACK: k(8, 'Backspace', 'Backspace'),
	ESCAPE: k(27, 'Escape', 'Escape'),
	PAGE_UP: k(33, 'PageUp', 'PageUp'),
	PAGE_DOWN: k(34, 'PageDown', 'PageDown')
};

export const KEYMAPS = {tizen: TIZEN, webos: WEBOS, pc: PC};

/**
 * @param {string} platform
 * @param {string|number} name key name (case-insensitive) or a raw numeric keyCode
 * @return {KeySpec}
 */
export function resolveKey(platform, name) {
	const map = KEYMAPS[platform] || KEYMAPS.tizen;
	const key = String(name === undefined || name === null ? '' : name).trim().toUpperCase();
	if (Object.prototype.hasOwnProperty.call(map, key)) {
		return map[key];
	}
	// allow passing a raw numeric code directly
	const asNum = Number(name);
	if (Number.isFinite(asNum) && asNum > 0) {
		return k(asNum);
	}
	throw new Error(
		`unknown key "${name}" for platform "${platform}". Known keys: ${Object.keys(map).join(', ')}`
	);
}

/**
 * @param {string} platform
 * @param {string|number} name
 * @return {number}
 */
export function resolveKeyCode(platform, name) {
	return resolveKey(platform, name).code;
}

/**
 * @param {string} platform
 * @return {Array<string>}
 */
export function knownKeys(platform) {
	return Object.keys(KEYMAPS[platform] || KEYMAPS.tizen);
}
