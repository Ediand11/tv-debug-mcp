// Synthetic input: build a KeyboardEvent inside the page and dispatch it on `document`.
//
// This is the ONLY thing that works on a TV. The CDP `Input` domain is unreliable (or
// absent) on old TV Chromium, and TV apps read the legacy `event.keyCode`, which no
// KeyboardEvent init dict ever populates — hence the defineProperty dance in inject.js.
//
// The trade-off is real and must never be hidden: these events are `isTrusted: false`,
// they go to `document` rather than the actually-focused element, and they do not trigger
// browser default actions. That is why every press result carries its `inputMode`.

import {keyEventJs} from '../inject.js';

export class SyntheticInput {
	constructor() {
		this.mode = 'synthetic';
	}

	/**
	 * @param {import('../cdp.js').CdpSession} cdp
	 * @param {import('../keymaps.js').KeySpec} spec
	 */
	keyDown(cdp, spec) {
		return cdp.evaluate(keyEventJs('keydown', spec), {awaitPromise: false});
	}

	/**
	 * @param {import('../cdp.js').CdpSession} cdp
	 * @param {import('../keymaps.js').KeySpec} spec
	 */
	keyUp(cdp, spec) {
		return cdp.evaluate(keyEventJs('keyup', spec), {awaitPromise: false});
	}
}
