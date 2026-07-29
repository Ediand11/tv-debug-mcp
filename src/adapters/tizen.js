// Tizen (Samsung) device adapter — drives sdb + the Tizen CLI.
//
// Debug-launch quirk (verified on a Tizen 5.5 set, sdb 4.2.36): the command is
//     sdb -s <serial> shell 0 debug <appId>
// with NO timeout argument. Passing a numeric timeout ("... debug <app> 60") makes the
// launchpad answer "closed" instead of a port. The command STREAMS and holds the channel
// open; it prints a single line like
//     ... successfully launched pid = 5491 with debug 1 port: 46507
// The on-device inspector port survives closing that channel (verified: curl to the
// forwarded port still answers Chrome/69 after the sdb child is gone) — so we parse the
// port and drop the child instead of babysitting it for the whole session.
//
// Every device operation carries `-s <serial>`: without it a second connected TV makes
// `shell`/`debug`/`forward` land on whichever device sdb feels like.

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {spawnUntilMatch, stopChild} from './spawn-until-match.js';

const execFileP = promisify(execFile);

/**
 * Parse `sdb devices` into rows. The header line ("List of devices attached") is why a
 * naive `stdout.includes('device')` is always true.
 * @param {string} stdout
 * @return {Array<{serial: string, state: string, name: string}>}
 */
export function parseSdbDevices(stdout) {
	return String(stdout || '')
		.replace(/\r/g, '')
		.split('\n')
		.map((l) => l.trim())
		.filter((l) => l && !/^List of devices/i.test(l))
		.map((l) => {
			const [serial, state, ...rest] = l.split(/\s+/);
			return {serial, state: state || 'unknown', name: rest.join(' ')};
		})
		.filter((r) => r.serial && r.serial.includes(':'));
}

export class TizenAdapter {
	/**
	 * @param {{host: string, sdbPort?: number, cliTarget?: string, log?: Function}} opts
	 */
	constructor(opts) {
		this.platform = 'tizen';
		this._host = opts.host;
		this._sdbPort = opts.sdbPort || 26101;
		this._cliTarget = opts.cliTarget || null;
		this._log = opts.log || (() => {});
		/** Device-side inspector port of the last successful debug launch. */
		this._lastDevicePort = null;
	}

	/** Operations this adapter really supports (surfaced by tv_devices). */
	get capabilities() {
		return {install: true, uninstall: true, killApp: true, relaunch: true, attach: true, navigate: true};
	}

	get serial() {
		return `${this._host}:${this._sdbPort}`;
	}

	/** Device-scoped sdb argv. */
	_args(args) {
		return ['-s', this.serial, ...args];
	}

	/**
	 * Run sdb. Throws on a non-zero exit unless `tolerant` — the old version turned every
	 * failure into a successful-looking string, so a failed `forward` still produced an
	 * endpoint (pointing at whatever was previously bound to that local port).
	 * @param {Array<string>} args
	 * @param {{timeout?: number, tolerant?: boolean, global?: boolean}} [opts]
	 * @return {Promise<string>}
	 */
	async _sdb(args, opts = {}) {
		const argv = opts.global ? args : this._args(args);
		try {
			const {stdout, stderr} = await execFileP('sdb', argv, {timeout: opts.timeout || 30000, encoding: 'utf8'});
			return (stdout + stderr).replace(/\r/g, '');
		} catch (e) {
			const out = ((e.stdout || '') + (e.stderr || '')).replace(/\r/g, '');
			if (opts.tolerant) {
				return out || String(e.message || e);
			}
			throw new Error(`sdb ${argv.join(' ')} failed: ${e.message}\n${out.slice(-400)}`);
		}
	}

	/**
	 * Ensure sdb is connected to this device.
	 */
	async connect() {
		const before = await this._sdb(['devices'], {global: true, tolerant: true});
		if (!parseSdbDevices(before).some((d) => d.serial === this.serial)) {
			this._log(`sdb connect ${this.serial}`);
			await this._sdb(['connect', this.serial], {global: true, tolerant: true});
		}
		const rows = parseSdbDevices(await this._sdb(['devices'], {global: true, tolerant: true}));
		const row = rows.find((d) => d.serial === this.serial);
		if (!row || row.state !== 'device') {
			throw new Error(
				`sdb could not connect to ${this.serial} (state: ${row ? row.state : 'absent'}). Is the TV on and in Developer Mode?`
			);
		}
		if (!this._cliTarget && row.name) {
			// `tizen install -t <name>` needs the CLI target name, which is the third column
			// of `sdb devices`. Deriving it beats making every config entry carry it.
			this._cliTarget = row.name;
		}
		return row;
	}

	/**
	 * @param {string} wgtPath absolute path to a .wgt
	 * @param {{appId?: string, uninstallFirst?: boolean}} [opts]
	 * @return {Promise<string>} tizen install output
	 */
	async install(wgtPath, opts = {}) {
		await this.connect();
		if (opts.uninstallFirst && opts.appId) {
			this._log(`uninstalling ${opts.appId} first`);
			await this.uninstall(opts.appId).catch((e) => this._log('uninstall failed (continuing):', e.message));
		}
		const args = ['install', ...(this._cliTarget ? ['-t', this._cliTarget] : []), '-n', wgtPath];
		this._log(`tizen ${args.join(' ')}`);
		const {stdout, stderr} = await execFileP('tizen', args, {timeout: 180000, encoding: 'utf8'})
			.catch((e) => ({stdout: e.stdout || '', stderr: e.stderr || String(e)}));
		const out = (stdout + stderr).replace(/\r/g, '');
		if (/Author certificate not match/.test(out)) {
			throw new Error(
				'Author certificate mismatch — an app signed with a different cert is installed. ' +
				'Retry with uninstallFirst:true.\n' + out.slice(-400)
			);
		}
		if (!/successfully installed/i.test(out)) {
			throw new Error('install did not report success:\n' + out.slice(-600));
		}
		if (!this._cliTarget) {
			this._log('warning: no Tizen CLI target resolved — install used the CLI default device');
		}
		return out;
	}

	/**
	 * @param {string} appId
	 */
	async uninstall(appId) {
		await this.connect();
		await this.kill(appId);
		const args = ['uninstall', ...(this._cliTarget ? ['-t', this._cliTarget] : []), '-p', appId];
		const {stdout, stderr} = await execFileP('tizen', args, {timeout: 60000, encoding: 'utf8'})
			.catch((e) => ({stdout: e.stdout || '', stderr: e.stderr || String(e)}));
		return (stdout + stderr).replace(/\r/g, '');
	}

	/**
	 * Terminate the running app. `was_kill` is the command that actually works on a
	 * restricted retail TV shell (`kill_app` is a silent no-op there); after it a fresh
	 * `debug` launch yields a new inspector port. Returns true if the TV acknowledged.
	 * @param {string} appId
	 * @return {Promise<boolean>}
	 */
	async kill(appId) {
		const out = await this._sdb(['shell', '0', 'was_kill', appId], {tolerant: true});
		this._lastDevicePort = null;
		return /terminate app/i.test(out);
	}

	/**
	 * Debug-launch the app and return the on-device inspector port. The streaming sdb child
	 * is stopped once the port is parsed — the inspector outlives it.
	 * @param {string} appId
	 * @param {number} [waitMs]
	 * @return {Promise<number>} device port
	 */
	async launchDebug(appId, waitMs = 15000) {
		this._log(`sdb -s ${this.serial} shell 0 debug ${appId}`);
		const {value, child} = await spawnUntilMatch(
			'sdb',
			this._args(['shell', '0', 'debug', appId]),
			{
				what: `sdb debug ${appId}`,
				timeoutMs: waitMs,
				match: (buf) => {
					const m = buf.match(/port:\s*(\d+)/);
					return m ? parseInt(m[1], 10) : null;
				},
				fail: (buf) => /\bclosed\b/.test(buf)
					? 'debug launch returned "closed" — the app is already running in debug. ' +
					  'Use tv_launch {attach: true} to reuse it, or {relaunch: true} for a fresh start.'
					: null
			}
		);
		await stopChild(child);
		this._lastDevicePort = value;
		return value;
	}

	/**
	 * @param {number} localPort
	 * @param {number} devicePort
	 * @return {Promise<string>} CDP http base
	 */
	async forward(localPort, devicePort) {
		// Exactly one rule per device: stale rules from earlier runs (different random local
		// port) would otherwise pile up and confuse the attach lookup below.
		for (const {local} of await this._forwardRules()) {
			await this._sdb(['forward', '--remove', `tcp:${local}`], {tolerant: true});
		}
		await this._sdb(['forward', '--remove', `tcp:${localPort}`], {tolerant: true});
		await this._sdb(['forward', `tcp:${localPort}`, `tcp:${devicePort}`]);
		return `http://127.0.0.1:${localPort}`;
	}

	async removeForward(localPort) {
		await this._sdb(['forward', '--remove', `tcp:${localPort}`], {tolerant: true}).catch(() => {});
	}

	/**
	 * Forward rules this sdb server holds for our serial. They outlive the MCP process,
	 * which is what makes `attach` work after a restart: the device-side inspector port is
	 * otherwise unknowable.
	 * @return {Promise<Array<{local: number, device: number}>>}
	 */
	async _forwardRules() {
		const out = await this._sdb(['forward', '--list'], {global: true, tolerant: true});
		const rules = [];
		for (const line of out.split('\n')) {
			if (!line.includes(this.serial)) {
				continue;
			}
			const ports = line.match(/tcp:(\d+)\s+tcp:(\d+)/);
			if (ports) {
				rules.push({local: parseInt(ports[1], 10), device: parseInt(ports[2], 10)});
			}
		}
		return rules;
	}

	/** @return {Promise<?number>} */
	async _forwardedDevicePort() {
		const rules = await this._forwardRules();
		return rules.length ? rules[0].device : null;
	}

	/**
	 * Uniform entry point: (optionally) kill any running instance for a deterministic
	 * fresh start, debug-launch, forward, and return a CDP HTTP base.
	 *
	 * `attach` reuses the inspector of an app that is ALREADY running in debug: a second
	 * `debug` on such an app answers "closed", so attaching has to go through the port we
	 * remember (or the forward rule sdb still holds), not through a relaunch.
	 *
	 * Takes the whole device config rather than an app id: the `pc` adapter's target is a
	 * URL and a browser process, and baking "the target is an appId" into the signature is
	 * what made the abstraction leak.
	 * @param {import('../config.js').DeviceConfig} cfg
	 * @param {{localPort: number, attach?: boolean}} opts
	 * @return {Promise<{httpBase: string, devicePort: number, freshLaunch: boolean}>}
	 */
	async acquireEndpoint(cfg, {localPort, attach = false}) {
		const appId = cfg.appId;
		await this.connect();

		if (attach) {
			const known = this._lastDevicePort || (await this._forwardedDevicePort());
			if (known) {
				const httpBase = await this.forward(localPort, known);
				if (await probeInspector(httpBase)) {
					this._lastDevicePort = known;
					return {httpBase, devicePort: known, freshLaunch: false};
				}
			}
			// Nothing to attach to (or it went away) — a plain debug launch is still correct
			// for an app that is running WITHOUT debug, and its "closed" failure carries the
			// right advice for the case where it is already in debug on an unknown port.
			const devicePort = await this.launchDebug(appId);
			const httpBase = await this.forward(localPort, devicePort);
			return {httpBase, devicePort, freshLaunch: true};
		}

		if (await this.kill(appId)) {
			await new Promise((r) => setTimeout(r, 1500));
		}
		const devicePort = await this.launchDebug(appId);
		const httpBase = await this.forward(localPort, devicePort);
		return {httpBase, devicePort, freshLaunch: true};
	}

	async dispose() {
		// Nothing long-lived: the debug channel is closed right after the port is parsed.
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
