// Supervised "spawn a CLI and watch its output until a line matches".
//
// Both device adapters need the same thing: run a streaming CLI (`sdb shell 0 debug`,
// `ares-inspect`), scan stdout+stderr for the line that carries the inspector endpoint,
// and give up after a deadline. Doing it twice produced the same three bugs twice:
// no `error` listener (a missing binary killed the whole MCP process), a child left
// running after a timeout, and a stale reference in the adapter field.

import {spawn} from 'node:child_process';

const MAX_OUTPUT = 64 * 1024;

/**
 * Terminate a child and wait (briefly) for it to actually go away.
 * @param {?import('node:child_process').ChildProcess} child
 * @param {number} [graceMs]
 * @return {Promise<void>}
 */
export function stopChild(child, graceMs = 2000) {
	if (!child || child.exitCode !== null || child.signalCode) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			try {
				child.kill('SIGKILL');
			} catch {
				// ignore
			}
			resolve();
		}, graceMs);
		child.once('exit', done);
		try {
			child.kill('SIGTERM');
		} catch {
			done();
		}
	});
}

/**
 * @param {string} command
 * @param {Array<string>} args
 * @param {{
 *   match: function(string): *,
 *   fail?: function(string): ?string,
 *   timeoutMs?: number,
 *   what?: string
 * }} opts `match` returns a truthy value to resolve with; `fail` returns an error message
 *   to reject with. Both are called with the accumulated stdout+stderr.
 * @return {Promise<{value: *, child: import('node:child_process').ChildProcess, output: string}>}
 *   The child is still running on success — the caller owns it from there.
 */
export function spawnUntilMatch(command, args, opts) {
	const {match, fail, timeoutMs = 15000, what = `${command} ${args.join(' ')}`} = opts;
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
		} catch (e) {
			reject(new Error(`cannot spawn ${command}: ${e.message}`));
			return;
		}

		let buf = '';
		let settled = false;

		const finish = (fn, arg) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			child.stdout.removeAllListeners('data');
			child.stderr.removeAllListeners('data');
			fn(arg);
		};
		// Reject path always takes the child with it — a timed-out `sdb debug` left running
		// interferes with the next launch.
		const rejectWith = (err) => {
			if (settled) {
				return;
			}
			stopChild(child).then(() => finish(reject, err), () => finish(reject, err));
		};

		const scan = (chunk) => {
			buf += chunk.toString().replace(/\r/g, '');
			if (buf.length > MAX_OUTPUT) {
				buf = buf.slice(-MAX_OUTPUT);
			}
			const failure = fail && fail(buf);
			if (failure) {
				rejectWith(new Error(failure));
				return;
			}
			const value = match(buf);
			if (value) {
				finish(resolve, {value, child, output: buf});
			}
		};

		// Without this a missing binary (ENOENT) is an unhandled 'error' event.
		child.once('error', (e) => finish(reject, new Error(`${command} failed to start: ${e.message}`)));
		child.stdout.on('data', scan);
		child.stderr.on('data', scan);
		child.once('exit', (code) => {
			finish(reject, new Error(`${what} exited (code ${code}) without a match.\n${buf.slice(-400)}`));
		});

		const timer = setTimeout(() => {
			rejectWith(new Error(`${what} timed out after ${timeoutMs}ms.\n${buf.slice(-400)}`));
		}, timeoutMs);
	});
}
