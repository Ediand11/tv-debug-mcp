// Trusted input: real browser key events via the CDP `Input` domain.
//
// Only used on the `pc` platform, where the engine is a current Chrome that supports it.
// These events are `isTrusted: true`, are delivered to the actually-focused element, and
// fire default browser actions — i.e. they exercise the paths a real user does, which
// synthetic dispatch cannot.
//
// This means a browser run and a TV run are NOT the same experiment. A case can pass here
// and fail on the TV (the app's TV keyCode branch is never exercised) or fail here for
// browser-only reasons (Backspace navigating back). So: the mode is recorded in every
// press result, there is no silent fallback between the two, and navigation cases should
// also be run in synthetic parity mode (`inputMode: "synthetic"` on the device) before
// anyone concludes the TV will behave.

export class TrustedInput {
	constructor() {
		this.mode = 'trusted';
	}

	/**
	 * @param {import('../cdp.js').CdpSession} cdp
	 * @param {import('../keymaps.js').KeySpec} spec
	 */
	keyDown(cdp, spec) {
		return cdp.call('Input.dispatchKeyEvent', this._payload('keyDown', spec));
	}

	/**
	 * @param {import('../cdp.js').CdpSession} cdp
	 * @param {import('../keymaps.js').KeySpec} spec
	 */
	keyUp(cdp, spec) {
		return cdp.call('Input.dispatchKeyEvent', this._payload('keyUp', spec));
	}

	/**
	 * @param {'keyDown'|'keyUp'} type
	 * @param {import('../keymaps.js').KeySpec} spec
	 */
	_payload(type, spec) {
		const payload = {
			type,
			key: spec.key || '',
			code: spec.domCode || '',
			windowsVirtualKeyCode: spec.code,
			nativeVirtualKeyCode: spec.code
		};
		// `text` is what makes a keyDown produce actual input; only printable keys and Enter
		// carry it.
		if (type === 'keyDown') {
			if (spec.key === 'Enter') {
				payload.text = '\r';
			} else if (spec.key && spec.key.length === 1) {
				payload.text = spec.key;
			}
		}
		return payload;
	}
}
