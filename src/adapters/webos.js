// webOS (LG) device adapter — drives the ares CLI.
//
// Unlike Tizen, `ares-inspect -a <appId>` opens the Web Inspector AND sets up local
// forwarding itself, printing a URL that embeds `ws=localhost:<port>/devtools/page/<id>`
// (or a bare `http://localhost:<port>`). The ares-inspect child must stay alive for that
// tunnel to persist, so this adapter — unlike the Tizen one — keeps its child.
//
// Fresh-start semantics match Tizen: unless `attach` is asked for, the app is closed and
// relaunched first, so a run always starts from a known state. Mechanics mirror the proven
// webos-install skill (inspect-check.mjs). webOS 3 (Chrome 38) only speaks a CDP subset:
// key injection via Runtime.evaluate works, Page.captureScreenshot support varies.
// webOS 2 (WebKit 538, legacy inspector) prints the bare `http://localhost:<port>` form;
// discovery there goes through /pagelist.json in resolvePageWs, not /json/list.

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {spawnUntilMatch, stopChild} from './spawn-until-match.js';

/** How long `close()` waits for the app to leave `ares-launch --running` (see _waitClosed). */
const CLOSE_WAIT_MS = 8000;
const CLOSE_POLL_MS = 400;

const execFileP = promisify(execFile);

export class WebosAdapter {
	/**
	 * @param {{device?: string, log?: Function}} opts
	 */
	constructor(opts) {
		this.platform = 'webos';
		this._device = opts.device || null; // ares device name; null => ares default
		this._log = opts.log || (() => {});
		/** @type {?import('node:child_process').ChildProcess} */
		this._inspectChild = null;
	}

	get capabilities() {
		return {install: true, uninstall: true, killApp: true, relaunch: true, attach: true, navigate: true};
	}

	_dev() {
		return this._device ? ['-d', this._device] : [];
	}

	async connect() {
		// ares uses a device registry (ares-setup-device); nothing to dial here.
		return true;
	}

	/**
	 * @param {string} ipkPath absolute path to a .ipk
	 * @param {{appId?: string, uninstallFirst?: boolean}} [opts]
	 */
	async install(ipkPath, opts = {}) {
		if (opts.uninstallFirst && opts.appId) {
			await this.uninstall(opts.appId).catch((e) => this._log('uninstall failed (continuing):', e.message));
		}
		this._log(`ares-install ${this._dev().join(' ')} ${ipkPath}`);
		const out = await this._ares('ares-install', [...this._dev(), ipkPath], 180000);
		if (!/success/i.test(out)) {
			throw new Error('ares-install did not report success:\n' + out.slice(-600));
		}
		return out;
	}

	/**
	 * @param {string} appId
	 */
	async uninstall(appId) {
		await this.close(appId);
		return this._ares('ares-install', [...this._dev(), '-r', appId], 60000);
	}

	async launch(appId) {
		return this._ares('ares-launch', [...this._dev(), appId], 30000);
	}

	/**
	 * Close the running app. Named `kill` on the Tizen adapter; both are exposed under the
	 * same session-level operation.
	 * @param {string} appId
	 * @return {Promise<boolean>}
	 */
	async close(appId) {
		this._stopInspectChild();
		const out = await this._ares('ares-launch', [...this._dev(), '--close', appId], 30000);
		const ok = !/error|failed/i.test(out);
		if (ok) {
			await this._waitClosed(appId);
		}
		return ok;
	}

	/**
	 * `--close` returns before the app is gone. A launch that lands while the old instance is
	 * still tearing down (a healthy one, mid-trailer, takes a while) resumes the dying process
	 * and the app never renders — on webOS 7 that was every other cold start, 40s each. Poll
	 * the running list until the id is absent; give up quietly after CLOSE_WAIT_MS and let
	 * the launch (and its bootReady retry) take it from there.
	 * @param {string} appId
	 */
	async _waitClosed(appId) {
		const deadline = Date.now() + CLOSE_WAIT_MS;
		while (Date.now() < deadline) {
			const out = await this._ares('ares-launch', [...this._dev(), '--running'], 10000);
			if (!out.split('\n').some((l) => l.trim() === appId || l.trim().startsWith(appId + ' '))) {
				return;
			}
			await new Promise((r) => setTimeout(r, CLOSE_POLL_MS));
		}
		this._log(`${appId} still listed as running ${CLOSE_WAIT_MS}ms after --close; launching anyway`);
	}

	/** Alias so the session layer can treat both adapters identically. */
	kill(appId) {
		return this.close(appId);
	}

	async _ares(bin, args, timeout) {
		const {stdout, stderr} = await execFileP(bin, args, {timeout, encoding: 'utf8'})
			.catch((e) => ({stdout: e.stdout || '', stderr: e.stderr || String(e.message || e)}));
		return (stdout + stderr).replace(/\r/g, '');
	}

	_stopInspectChild() {
		const child = this._inspectChild;
		this._inspectChild = null;
		return stopChild(child);
	}

	/**
	 * @param {import('../config.js').DeviceConfig} cfg
	 * @param {{attach?: boolean}} [opts]
	 * @return {Promise<{wsUrl?: string, httpBase?: string, freshLaunch: boolean, keepalive: false}>}
	 */
	async acquireEndpoint(cfg, opts = {}) {
		const appId = cfg.appId;
		const fresh = !opts.attach;
		await this._stopInspectChild();
		if (fresh) {
			await this.close(appId);
			await this.launch(appId);
			await new Promise((r) => setTimeout(r, 1500));
		}

		this._log(`ares-inspect ${this._dev().join(' ')} -a ${appId}`);
		const {value, child} = await spawnUntilMatch(
			'ares-inspect',
			[...this._dev(), '-a', appId],
			{
				what: `ares-inspect ${appId}`,
				timeoutMs: 20000,
				match: (buf) => {
					const wsm = buf.match(/ws=([^\s&]+\/devtools\/page\/[A-Za-z0-9-]+)/);
					if (wsm) {
						return {wsUrl: 'ws://' + wsm[1]};
					}
					const httpm = buf.match(/https?:\/\/(localhost:\d+)/);
					if (httpm && /Debugging|devtools/i.test(buf)) {
						return {httpBase: 'http://' + httpm[1]};
					}
					return null;
				}
			}
		);
		// The tunnel lives as long as this child does.
		this._inspectChild = child;
		// keepalive: false — the ares-inspect tunnel is a node proxy, not a port forward, and it
		// does not survive a WebSocket ping frame: after the first one every message on that
		// session is silently dropped (no pong, no close), while a fresh session to the same
		// page works. Verified on webOS 7; the CdpSession ping would kill every session 15s in.
		return {...value, freshLaunch: fresh, keepalive: false};
	}

	async dispose() {
		await this._stopInspectChild();
	}
}
