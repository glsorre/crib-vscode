import * as assert from 'assert';
import * as net from 'net';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { AgentRelayManager, sanitizeKey, startAgentRelay } from '../sshAgentRelay';

/** Minimal upstream "agent": every connection echoes back `> ` + whatever it receives. */
function startEchoUpstream(sockPath: string): Promise<net.Server> {
	const server = net.createServer(conn => {
		conn.on('data', chunk => conn.write(Buffer.concat([Buffer.from('> '), chunk])));
		conn.on('error', () => conn.destroy());
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(sockPath, () => resolve(server));
	});
}

function roundtrip(sockPath: string, payload: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const client = net.connect(sockPath);
		let out = '';
		client.on('data', chunk => {
			out += chunk.toString();
			client.end();
		});
		client.on('end', () => resolve(out));
		client.on('error', reject);
		client.on('connect', () => client.write(payload));
	});
}

suite('sshAgentRelay', () => {
	let dir: string;

	setup(async () => {
		dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cr-'));
	});

	teardown(async () => {
		await fs.promises.rm(dir, { recursive: true, force: true });
	});

	test('relays bytes both ways between the relay socket and the real agent', async () => {
		const realSock = path.join(dir, 'u.sock');
		const relayPath = path.join(dir, 'r.sock');
		const upstream = await startEchoUpstream(realSock);
		const relay = await startAgentRelay(realSock, relayPath);
		try {
			assert.strictEqual(relay.path, relayPath);
			const reply = await roundtrip(relayPath, 'ping');
			assert.strictEqual(reply, '> ping');
		} finally {
			await relay.dispose();
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		}
	});

	test('creates the relay socket with owner-only permissions', async () => {
		const realSock = path.join(dir, 'u.sock');
		const relayPath = path.join(dir, 'r.sock');
		const upstream = await startEchoUpstream(realSock);
		const relay = await startAgentRelay(realSock, relayPath);
		try {
			const mode = (await fs.promises.stat(relayPath)).mode & 0o777;
			assert.strictEqual(mode, 0o600);
		} finally {
			await relay.dispose();
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		}
	});

	test('dispose() closes the server and removes the socket file', async () => {
		const realSock = path.join(dir, 'u.sock');
		const relayPath = path.join(dir, 'r.sock');
		const upstream = await startEchoUpstream(realSock);
		const relay = await startAgentRelay(realSock, relayPath);
		await relay.dispose();
		assert.strictEqual(fs.existsSync(relayPath), false);
		await new Promise<void>(resolve => upstream.close(() => resolve()));
	});

	test('startAgentRelay replaces a stale socket file at the same path', async () => {
		const realSock = path.join(dir, 'u.sock');
		const relayPath = path.join(dir, 'r.sock');
		const upstream = await startEchoUpstream(realSock);
		await fs.promises.writeFile(relayPath, 'stale'); // leftover from a prior session
		const relay = await startAgentRelay(realSock, relayPath);
		try {
			const reply = await roundtrip(relayPath, 'hi');
			assert.strictEqual(reply, '> hi');
		} finally {
			await relay.dispose();
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		}
	});

	suite('AgentRelayManager', () => {
		test('ensure() returns a stable per-key path and rebinds the upstream', async () => {
			const realA = path.join(dir, 'a.sock');
			const realB = path.join(dir, 'b.sock');
			const upstreamA = await startEchoUpstream(realA);
			const mgr = new AgentRelayManager(dir);
			try {
				const p1 = await mgr.ensure('ws', realA);
				assert.strictEqual(p1, path.join(dir, 'ws.sock'));
				assert.strictEqual(await roundtrip(p1, 'a'), '> a');

				// Rebind the same key to a new upstream (new editor session sock).
				const upstreamB = await startEchoUpstream(realB);
				const p2 = await mgr.ensure('ws', realB);
				assert.strictEqual(p2, p1, 'relay path is stable across rebinds');
				assert.strictEqual(await roundtrip(p2, 'b'), '> b');
				await new Promise<void>(resolve => upstreamB.close(() => resolve()));
			} finally {
				await mgr.disposeAll();
				await new Promise<void>(resolve => upstreamA.close(() => resolve()));
			}
		});

		test('disposeAll() removes all relay socket files', async () => {
			const real = path.join(dir, 'u.sock');
			const upstream = await startEchoUpstream(real);
			const mgr = new AgentRelayManager(dir);
			const p = await mgr.ensure('ws', real);
			await mgr.disposeAll();
			assert.strictEqual(fs.existsSync(p), false);
			await new Promise<void>(resolve => upstream.close(() => resolve()));
		});
	});

	suite('sanitizeKey', () => {
		test('keeps safe characters and replaces path separators', () => {
			assert.strictEqual(sanitizeKey('crib-vscode-215229b'), 'crib-vscode-215229b');
			assert.strictEqual(sanitizeKey('a/b\\c d'), 'a_b_c_d');
		});

		test('falls back to a default for empty/garbage keys', () => {
			assert.strictEqual(sanitizeKey(''), 'agent');
			assert.strictEqual(sanitizeKey('///'), 'agent');
		});
	});
});
