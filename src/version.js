// The package version, read once — `server.js` and the HAR creator both report it, and a
// literal in either drifted from package.json twice already.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

let version = '0.0.0';
try {
	const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
	version = String(pkg.version || version);
} catch {
	// a broken package.json must not take the server down over a version string
}

export const PKG_VERSION = version;
