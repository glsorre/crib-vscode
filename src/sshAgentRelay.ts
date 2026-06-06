/**
 * Host-local SSH agent relay. No vscode dependency so it is unit-testable in isolation.
 *
 * On hosts where the Docker daemon cannot bind-mount the editor-created agent socket
 * (e.g. Cursor remote-SSH's /tmp/cursor-remote-ssh-auth-sock-*.sock under snap/rootless
 * Docker — see ./sshAgentForwarding.ts), we expose the agent at a path the daemon *can*
 * mount: a unix socket under $HOME. Each inbound connection is piped to the real agent
 * socket, so crib can bind-mount the relay path and the agent still works in-container.
 */

import * as net from 'net';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

export interface AgentRelay {
	/** Path of the host-local relay socket to hand to crib via SSH_AUTH_SOCK. */
	readonly path: string;
	/** Close the relay server and remove its socket file. */
	dispose(): Promise<void>;
}

/**
 * Start a relay listening at `relayPath` that forwards every connection to `realSock`.
 * Recreates a fresh server (unlinking any stale socket file first).
 */
export async function startAgentRelay(realSock: string, relayPath: string): Promise<AgentRelay> {
	await fs.promises.mkdir(path.dirname(relayPath), { recursive: true });
	await unlinkIfExists(relayPath);

	const server = net.createServer(downstream => {
		downstream.on('error', () => downstream.destroy());
		const upstream = net.connect(realSock);
		upstream.on('error', () => {
			downstream.destroy();
			upstream.destroy();
		});
		downstream.pipe(upstream);
		upstream.pipe(downstream);
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(relayPath, () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	// Restrict to the owner; the relay proxies the user's own agent.
	await fs.promises.chmod(relayPath, 0o600);

	return {
		path: relayPath,
		dispose: async () => {
			await new Promise<void>(resolve => server.close(() => resolve()));
			await unlinkIfExists(relayPath);
		},
	};
}

/**
 * Owns one relay per workspace key. The relay path is stable per key so crib's bind-mount
 * path stays stable across sessions; the upstream target is rebound to the current realSock.
 */
export class AgentRelayManager {
	private readonly relays = new Map<string, AgentRelay>();

	constructor(private readonly relayDir: string = path.join(os.homedir(), '.crib', 'agent')) {}

	/** Start (or rebind) the relay for `key` pointing at `realSock`; returns the relay socket path. */
	async ensure(key: string, realSock: string): Promise<string> {
		const relayPath = path.join(this.relayDir, `${sanitizeKey(key)}.sock`);
		// Rebind: tear down any existing relay for this key (upstream sock may have changed).
		const existing = this.relays.get(key);
		if (existing) {
			await existing.dispose();
			this.relays.delete(key);
		}
		const relay = await startAgentRelay(realSock, relayPath);
		this.relays.set(key, relay);
		return relay.path;
	}

	async disposeAll(): Promise<void> {
		const all = [...this.relays.values()];
		this.relays.clear();
		await Promise.all(all.map(r => r.dispose()));
	}
}

/** Make a workspace key safe for use as a single path segment. */
export function sanitizeKey(key: string): string {
	const cleaned = key.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
	return cleaned.length > 0 ? cleaned.slice(0, 80) : 'agent';
}

async function unlinkIfExists(p: string): Promise<void> {
	try {
		await fs.promises.unlink(p);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw err;
		}
	}
}
