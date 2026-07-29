// Phase-0 acceptance: the repairs, on a real TV.
//
// Checks, in order:
//   1. tv_devices reports the real sdb state (it used to say "connected" for everything)
//   2. a fresh tv_launch attaches, and the sdb debug child is NOT kept alive
//   3. keys still drive focus after the KeySpec/ES5 rework
//   4. tv_video_state runs the ES5 probe without throwing
//   5. tv_console {limit:1} returns 1 entry, not the whole buffer (slice(-0) bug)
//   6. a SECOND server process can tv_launch {attach:true} onto the still-running app,
//      keeping its localStorage — i.e. attach works and killing the sdb channel did not
//      kill the inspector
//
// Run: node test/phase0-check.mjs
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'src', 'server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
	if (ok) {
		passed++;
		console.log(`  PASS  ${name}`);
	} else {
		failed++;
		console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
	}
}

function startServer(label) {
	const child = spawn('node', [serverPath], {stdio: ['pipe', 'pipe', 'pipe']});
	child.stderr.on('data', (c) => {
		const s = c.toString().trim();
		if (s) {
			console.log(`    [${label}] ${s.split('\n').join(`\n    [${label}] `)}`);
		}
	});
	let id = 0;
	let buf = '';
	const pending = new Map();
	child.stdout.on('data', (chunk) => {
		buf += chunk.toString();
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) {
				continue;
			}
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.id && pending.has(msg.id)) {
				pending.get(msg.id)(msg);
				pending.delete(msg.id);
			}
		}
	});
	const rpc = (method, params) => new Promise((res) => {
		const myId = ++id;
		pending.set(myId, res);
		child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: myId, method, params}) + '\n');
	});
	const call = async (name, args = {}) => {
		const r = await rpc('tools/call', {name, arguments: args});
		const text = r.result?.content?.[0]?.text;
		if (r.result?.isError) {
			return {__error: text};
		}
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	};
	const ready = (async () => {
		await sleep(400);
		await rpc('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: label, version: '0'}});
		child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
	})();
	return {child, rpc, call, ready, stop: () => child.kill('SIGTERM')};
}

const MARKER = 'tvdebug_phase0_' + process.pid;

async function main() {
	console.log('\n--- server A: fresh launch ---');
	const a = startServer('A');
	await a.ready;

	const devices = await a.call('tv_devices');
	const dev = devices.devices?.[0];
	check('tv_devices reports a real sdb state', dev?.status === 'device', `status=${dev?.status}`);
	check('tv_devices exposes capabilities', !!dev?.capabilities, JSON.stringify(dev?.capabilities));

	const launched = await a.call('tv_launch', {});
	check('tv_launch attaches', !!launched.attached?.wsUrl, launched.__error || JSON.stringify(launched).slice(0, 200));
	check('tv_launch reports a fresh launch', launched.attached?.freshLaunch === true);
	check('tv_launch allocated a local port', !!launched.attached?.localPort, String(launched.attached?.localPort));

	const stray = await new Promise((res) => {
		const p = spawn('bash', ['-lc', 'pgrep -fl "sdb .*shell 0 debug" | wc -l']);
		let out = '';
		p.stdout.on('data', (c) => (out += c));
		p.on('exit', () => res(parseInt(out.trim(), 10) || 0));
	});
	check('no sdb debug child left running', stray === 0, `${stray} still alive`);

	console.log('  booting 22s...');
	await sleep(22000);

	const before = await a.call('tv_press', {key: 'RIGHT'});
	await sleep(800);
	const after = await a.call('tv_press', {key: 'RIGHT'});
	check('keys move focus', before.focusedAfter !== after.focusedAfter,
		`${String(before.focusedAfter).slice(0, 50)} -> ${String(after.focusedAfter).slice(0, 50)}`);
	check('press reports its input mode', after.inputMode === 'synthetic');

	const vs = await a.call('tv_video_state', {sampleGapMs: 300});
	check('tv_video_state runs the ES5 probe', !vs.__error && typeof vs.found === 'number', vs.__error || JSON.stringify(vs).slice(0, 120));

	const con = await a.call('tv_console', {limit: 1});
	const buckets = [con.console?.length, con.errors?.length, con.networkFailures?.length];
	check('tv_console honours limit:1', buckets.every((n) => n <= 1), JSON.stringify(buckets));
	check('tv_console reports buffer drops', !!con.droppedFromBuffer, JSON.stringify(con.droppedFromBuffer));

	await a.call('tv_evaluate', {expression: `localStorage.setItem('${MARKER}','1'), 'set'`});
	const set = await a.call('tv_evaluate', {expression: `localStorage.getItem('${MARKER}')`});
	check('marker written to localStorage', set.value === '1', JSON.stringify(set));

	a.stop();
	await sleep(1500);

	console.log('\n--- server B: attach to the still-running app ---');
	const b = startServer('B');
	await b.ready;
	const attached = await b.call('tv_launch', {attach: true});
	check('attach succeeds from a new process', !!attached.attached?.wsUrl, attached.__error || JSON.stringify(attached).slice(0, 200));
	check('attach did NOT relaunch the app', attached.attached?.freshLaunch === false, `freshLaunch=${attached.attached?.freshLaunch}`);

	const stillThere = await b.call('tv_evaluate', {expression: `localStorage.getItem('${MARKER}')`});
	check('app state survived (same instance)', stillThere.value === '1', JSON.stringify(stillThere));

	console.log('\n--- socket drop mid-session ---');
	// Pull the forward out from under the live CDP socket: this is what a TV going to sleep
	// or dropping off wifi looks like. It used to kill the whole MCP process.
	const local = attached.attached?.localPort;
	await new Promise((res) => spawn('sdb', ['forward', '--remove', `tcp:${local}`]).on('exit', res));
	await sleep(1200);
	const afterDrop = await b.call('tv_evaluate', {expression: '1+1'});
	check('server survived the socket drop', b.child.exitCode === null);
	check('tool call after a drop either recovers or errors clearly',
		afterDrop.value === 2 || !!afterDrop.__error,
		JSON.stringify(afterDrop).slice(0, 160));

	const relaunched = await b.call('tv_launch', {attach: true});
	const healed = await b.call('tv_evaluate', {expression: `localStorage.getItem('${MARKER}')`});
	check('tv_launch recovers the session after a drop', healed.value === '1',
		relaunched.__error || JSON.stringify(healed));

	await b.call('tv_evaluate', {expression: `localStorage.removeItem('${MARKER}'), 'cleaned'`});
	b.stop();
	await sleep(500);

	console.log(`\n${passed} passed, ${failed} failed\n`);
	process.exit(failed ? 1 : 0);
}

main().catch((e) => {
	console.error('phase0-check crashed:', e);
	process.exit(2);
});
