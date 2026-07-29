// Minimal stdio JSON-RPC harness to exercise the server without Claude Code.
// Usage: node test/smoke.mjs '[{"method":"tools/call","params":{"name":"tv_devices","arguments":{}}}]'
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'src', 'server.js');

const calls = JSON.parse(process.argv[2] || '[]');
const child = spawn('node', [serverPath], {stdio: ['pipe', 'pipe', 'inherit']});

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

function rpc(method, params) {
	const myId = ++id;
	return new Promise((res) => {
		pending.set(myId, res);
		child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: myId, method, params}) + '\n');
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
	await sleep(400);
	const init = await rpc('initialize', {
		protocolVersion: '2024-11-05',
		capabilities: {},
		clientInfo: {name: 'smoke', version: '0'}
	});
	console.log('INIT ok:', !!init.result, 'server:', init.result?.serverInfo?.name);
	child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');

	const tools = await rpc('tools/list', {});
	console.log('TOOLS:', (tools.result?.tools || []).map((t) => t.name).join(', '));

	for (const c of calls) {
		if (c.method === 'wait') {
			console.log(`\n=== wait ${c.ms}ms ===`);
			await sleep(c.ms);
			continue;
		}
		const r = await rpc(c.method, c.params);
		const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error || r.result);
		console.log(`\n=== ${c.params?.name || c.method} ===`);
		console.log(text.slice(0, 2500));
	}
	child.kill('SIGTERM');
	process.exit(0);
}

run().catch((e) => {
	console.error('smoke failed:', e);
	child.kill('SIGTERM');
	process.exit(1);
});
