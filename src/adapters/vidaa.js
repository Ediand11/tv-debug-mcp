// Vidaa (Hisense) adapter — the simplest one in the park: pure attach over the network.
//
// After the community remote key-sequence (Home×3 → Up×2 → Right-Left-Right-Left-Right)
// the TV opens a full Chromium DevTools endpoint on the set itself — no sdb, no ares, no
// port forwarding, no long-lived children. The adapter's whole job is to hand the session
// an `httpBase` of `http://<tv-ip>:<port>`; discovery through `/json/list`, the shared
// CdpSession and synthetic input all work unmodified (verified live on a 50A53FEVS,
// VIDAA 9.0 / Chromium 111, port 9226).
//
// What the platform does NOT give us over the network, honestly declared in capabilities:
//   * no sideload — the app is the hosted stage build the TV already loads;
//   * no kill / cold-start — the only "relaunch" available is reloading the page in place.
//
// The debug port is NOT fixed across models/firmwares: 9226 on VIDAA 9, 9223 reported on
// older sets. Hence the `port` config field plus a narrow auto-scan when it is absent.
// The endpoint has no auth — anyone on the LAN can attach. Fine for a dev device; noted
// in the README.

const DEFAULT_PORT = 9226;
/** Narrow scan range for a park entry that does not pin "port". */
const SCAN_PORTS = [9226, 9222, 9223, 9224, 9225, 9227, 9228, 9229, 9230];

export class VidaaAdapter {
	/**
	 * @param {{host?: string, port?: number, log?: Function}} opts
	 */
	constructor(opts = {}) {
		this.platform = 'vidaa';
		this._host = opts.host || null;
		this._port = opts.port || null;
		this._log = opts.log || (() => {});
		/** Set by acquireEndpoint, consumed by afterConnect — a reload needs a live CDP. */
		this._reloadOnConnect = false;
	}

	get capabilities() {
		return {install: false, uninstall: false, killApp: false,
			relaunch: true, attach: true, navigate: true, screenshot: true};
	}

	async connect() {
		// The inspector lives on the TV; there is nothing to dial until acquireEndpoint.
		return true;
	}

	/**
	 * @param {import('../config.js').DeviceConfig} cfg
	 * @param {{relaunch?: boolean}} [opts]
	 * @return {Promise<{httpBase: string, devicePort: number, freshLaunch: boolean}>}
	 */
	async acquireEndpoint(cfg, opts = {}) {
		const host = cfg.host || this._host;
		const port = cfg.port || this._port || (await this._discoverPort(host));
		const httpBase = `http://${host}:${port}`;
		if (!(await probeInspector(httpBase))) {
			throw new Error(
				`vidaa inspector did not answer at ${httpBase}/json/version — ` +
				'enable dev mode on the TV with the remote (Home×3, Up×2, Right-Left-Right-Left-Right) ' +
				'and make sure the app is running'
			);
		}
		this._port = port;
		// The closest thing to a relaunch this platform has is a page reload; done in
		// afterConnect because it needs the CDP session that does not exist yet here.
		this._reloadOnConnect = !!opts.relaunch;
		// freshLaunch mirrors what really happened: a reload restarts the app's boot, so the
		// session's bootReady wait applies; a plain attach must not wait for the catalog.
		return {httpBase, devicePort: port, freshLaunch: this._reloadOnConnect};
	}

	/**
	 * @param {import('../cdp.js').CdpSession} cdp
	 */
	async afterConnect(cdp) {
		if (!this._reloadOnConnect) {
			return;
		}
		this._reloadOnConnect = false;
		this._log('vidaa: relaunch = reloading the page in place (no cold-start over the network)');
		const loaded = cdp.waitForLoad(20000);
		await cdp.evaluate('location.reload()', {awaitPromise: false});
		const res = await loaded;
		if (!res.loaded) {
			this._log('vidaa: no load event within 20s after reload');
		}
	}

	/**
	 * @param {string} host
	 * @return {Promise<number>}
	 */
	async _discoverPort(host) {
		// All candidates at once — sequentially, nine 2.5s timeouts were a 22s worst case on the
		// first connect. The preferred port is listed first, and wins ties.
		const hits = await Promise.all(SCAN_PORTS.map(async (port) => {
			const ok = await probeInspector(`http://${host}:${port}`);
			return ok ? port : null;
		}));
		const port = hits.find((p) => p != null);
		if (port != null) {
			this._log(`vidaa: found inspector on port ${port}`);
			return port;
		}
		throw new Error(
			`no vidaa inspector found on ${host} (scanned ports ${SCAN_PORTS.join(', ')}) — ` +
			'enable dev mode on the TV, or pin "port" in devices.json'
		);
	}

	async install() {
		throw new Error('tv_install does not apply to a vidaa device — the app is the hosted build the TV already loads.');
	}

	async uninstall() {
		throw new Error('tv_uninstall does not apply to a vidaa device.');
	}

	/** There is no way to close the hosted app over the network — only the remote can. */
	async kill() {
		return false;
	}

	async dispose() {
		// Nothing long-lived to tear down.
	}
}

/**
 * @param {string} httpBase
 * @return {Promise<boolean>}
 */
async function probeInspector(httpBase) {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), 2500);
	try {
		const res = await fetch(httpBase + '/json/version', {signal: ac.signal});
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(t);
	}
}
