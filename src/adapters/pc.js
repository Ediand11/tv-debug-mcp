// PC adapter — the same QA case, run against a local Chrome instead of a TV.
//
// Why it exists: every case used to need a physical TV. The browser run is fast, and its
// screenshots actually work (Tizen's secure video plane makes captureScreenshot hang), so
// it catches most regressions before anyone walks over to a set. What it does NOT prove is
// TV-engine behaviour — see the inputMode note in src/input/.
//
// Ownership rules, deliberately asymmetric:
//   * Chrome is OURS. We launch it with an isolated throwaway profile and kill it on
//     dispose. We never attach to the user's everyday browser.
//   * The dev server is THEIRS: the user's own process serving the code on disk; we only
//     check that it answers and say so clearly if it does not.
//
// Two traps, both verified on a real app:
//   * `--disable-web-security` is mandatory — an app whose bootstrap calls a token endpoint
//     on another origin dies on CORS and never starts.
//   * `Network.setCacheDisabled(true)` is mandatory — a dev server serving ES modules plus a
//     reused browser means silently running yesterday's bytes.

import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {stopChild} from './spawn-until-match.js';

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PcAdapter {
	/**
	 * @param {{chromePath?: string, profileDir?: string, chromeArgs?: Array<string>, log?: Function}} opts
	 */
	constructor(opts = {}) {
		this.platform = 'pc';
		this._chromePath = opts.chromePath || process.env.TV_DEBUG_CHROME || DEFAULT_CHROME;
		this._profileDir = opts.profileDir || null;
		this._ownProfile = !opts.profileDir;
		this._extraArgs = opts.chromeArgs || [];
		this._log = opts.log || (() => {});
		/** @type {?import('node:child_process').ChildProcess} */
		this._chrome = null;
		this._httpBase = null;
	}

	get capabilities() {
		return {install: false, uninstall: false, killApp: false, relaunch: true, attach: true, navigate: true, screenshot: true};
	}

	async connect() {
		return true;
	}

	async install() {
		throw new Error('tv_install does not apply to a pc device — the browser loads the dev server URL from devices.json. Build/serve the app yourself.');
	}

	async uninstall() {
		throw new Error('tv_uninstall does not apply to a pc device.');
	}

	async kill() {
		await this._stopChrome();
		return true;
	}

	async _stopChrome() {
		const chrome = this._chrome;
		this._chrome = null;
		this._httpBase = null;
		await stopChild(chrome, 3000);
	}

	/**
	 * @param {string} url
	 */
	async _requireDevServer(url) {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), 4000);
		try {
			const res = await fetch(url, {signal: ac.signal});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
		} catch (e) {
			throw new Error(
				`dev server at ${url} is not answering (${e.message}). Start it yourself — ` +
				'`npm start` in your app project. tv-debug-mcp never starts or stops your dev server, ' +
				'so it cannot race a second one onto the same port.'
			);
		} finally {
			clearTimeout(t);
		}
	}

	/**
	 * Launch our own Chrome and return its CDP endpoint. Port 0 + DevToolsActivePort instead
	 * of a fixed port: a hard-coded 9333 collides with any other CDP session on the machine
	 * and would silently drive someone else's browser.
	 * @return {Promise<string>} http base
	 */
	async _launchChrome() {
		if (!existsSync(this._chromePath)) {
			throw new Error(`Chrome not found at ${this._chromePath}. Set "chromePath" on the device or TV_DEBUG_CHROME.`);
		}
		if (!this._profileDir) {
			this._profileDir = mkdtempSync(join(tmpdir(), 'tv-debug-chrome-'));
		}
		const args = [
			'--remote-debugging-port=0',
			`--user-data-dir=${this._profileDir}`,
			// mandatory: the app's anonymous bootstrap is cross-origin
			'--disable-web-security',
			'--disable-site-isolation-trials',
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-features=Translate',
			'--window-size=1280,720',
			...this._extraArgs,
			'about:blank'
		];
		this._log(`launching Chrome (own profile ${this._profileDir})`);
		// The throwaway profile is REUSED across relaunches, and Chrome leaves the port file of
		// the previous run behind. Reading it would hand back a port nothing listens on any more
		// ("no inspectable page at http://127.0.0.1:…"), so it has to go before the spawn.
		const portFile = join(this._profileDir, 'DevToolsActivePort');
		try {
			rmSync(portFile, {force: true});
		} catch {
			// ignore
		}
		const child = spawn(this._chromePath, args, {stdio: ['ignore', 'ignore', 'pipe']});
		child.once('error', (e) => this._log('chrome failed to start:', e.message));
		child.stderr.resume();
		this._chrome = child;

		const deadline = Date.now() + 20000;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) {
				throw new Error(`Chrome exited (code ${child.exitCode}) before opening a debugging port`);
			}
			if (existsSync(portFile)) {
				const port = parseInt(readFileSync(portFile, 'utf8').split('\n')[0].trim(), 10);
				if (Number.isFinite(port) && port > 0) {
					return `http://127.0.0.1:${port}`;
				}
			}
			await sleep(200);
		}
		await this._stopChrome();
		throw new Error('Chrome did not report a DevTools port within 20s');
	}

	/**
	 * @param {import('../config.js').DeviceConfig} cfg
	 * @param {{attach?: boolean, relaunch?: boolean}} [opts]
	 * @return {Promise<{httpBase: string, freshLaunch: boolean}>}
	 */
	async acquireEndpoint(cfg, opts = {}) {
		await this._requireDevServer(cfg.url);
		if (opts.attach && this._chrome && this._chrome.exitCode === null && this._httpBase) {
			return {httpBase: this._httpBase, freshLaunch: false};
		}
		await this._stopChrome();
		this._httpBase = await this._launchChrome();
		return {httpBase: this._httpBase, freshLaunch: true};
	}

	/**
	 * Runs once the CDP session is attached: kill the module cache, then load the app.
	 * @param {import('../cdp.js').CdpSession} cdp
	 * @param {import('../config.js').DeviceConfig} cfg
	 * @param {{freshLaunch: boolean}} info
	 */
	async afterConnect(cdp, cfg, info) {
		await cdp.call('Network.setCacheDisabled', {cacheDisabled: true}).catch(() => {});
		if (info.freshLaunch) {
			this._log(`navigating to ${cfg.url}`);
			await cdp.navigate(cfg.url, 30000);
		}
	}

	async dispose() {
		await this._stopChrome();
		if (this._ownProfile && this._profileDir) {
			try {
				rmSync(this._profileDir, {recursive: true, force: true});
			} catch {
				// ignore
			}
			this._profileDir = null;
		}
	}
}
