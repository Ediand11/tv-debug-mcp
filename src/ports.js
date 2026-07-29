// Local TCP port allocation for CDP forwards.
//
// The park version of this MCP cannot use "9990 + index in the config": two devices in two
// MCP processes, or a stale `sdb forward` from a previous run, silently cross-wire sessions
// — you end up driving the TV you were debugging yesterday. Ask the OS for a free port
// instead, and only honour a hard-coded one when the config explicitly asks for it.

import {createServer} from 'node:net';

/**
 * @return {Promise<number>} a port that was free a moment ago
 */
export function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const {port} = srv.address();
			srv.close(() => resolve(port));
		});
	});
}

/**
 * @param {number} port
 * @return {Promise<boolean>}
 */
export function isPortFree(port) {
	return new Promise((resolve) => {
		const srv = createServer();
		srv.unref();
		srv.on('error', () => resolve(false));
		srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
	});
}
