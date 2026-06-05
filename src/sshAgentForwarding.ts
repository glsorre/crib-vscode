/**
 * Helpers for the crib `ssh` plugin's bind-mount of $SSH_AUTH_SOCK. Pure / no vscode dep
 * so they are unit-testable in isolation.
 *
 * Upstream crib unconditionally bind-mounts $SSH_AUTH_SOCK into the container at
 * /run/ssh-agent.sock when the env var is set. On hosts where the editor-created sock
 * has perms the Docker daemon cannot read (e.g. Cursor remote-SSH's
 * /tmp/cursor-remote-ssh-auth-sock-*.sock), `crib up`/`rebuild` fails with
 *   docker: invalid mount config for type "bind": stat <path>: permission denied
 */

/**
 * Detect the upstream-crib `ssh` plugin bind-mount failure in stderr.
 */
export function isSshAgentMountError(stderr: string): boolean {
	const m = stderr.match(/invalid mount config for type "bind":\s*stat\s+(\S+):\s*permission denied/i);
	if (!m) {
		return false;
	}
	const sockPath = m[1] ?? '';
	return /ssh/i.test(sockPath) || /\.sock(\s|$)/i.test(sockPath);
}

/**
 * Compute the env to hand the crib subprocess. Strips SSH_AUTH_SOCK when forwarding
 * is disabled, or when forwarding is on but the sock cannot be read by the extension
 * host (proxy for "docker daemon can't read it either"). Pure; injectable probe + log.
 */
export async function prepareSpawnEnv(
	baseEnv: NodeJS.ProcessEnv,
	forwardSshAgent: boolean,
	probeReadable: (path: string) => Promise<boolean>,
	logStrip: (sockPath: string) => void,
): Promise<NodeJS.ProcessEnv> {
	const env: NodeJS.ProcessEnv = { ...baseEnv };
	const sock = env.SSH_AUTH_SOCK;
	if (!sock) {
		return env;
	}
	if (!forwardSshAgent) {
		delete env.SSH_AUTH_SOCK;
		return env;
	}
	const readable = await probeReadable(sock);
	if (!readable) {
		logStrip(sock);
		delete env.SSH_AUTH_SOCK;
	}
	return env;
}
