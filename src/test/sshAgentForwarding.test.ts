import * as assert from 'assert';
import { isSshAgentMountError, prepareSpawnEnv } from '../sshAgentForwarding';

suite('isSshAgentMountError', () => {
	test('matches Cursor remote-SSH agent socket bind-mount failure', () => {
		const stderr =
			'docker: Error response from daemon: invalid mount config for type "bind": ' +
			'stat /tmp/cursor-remote-ssh-auth-sock-c4cee5e8-4dbd-4e21-afcf-05d17c53afa6.sock: ' +
			'permission denied';
		assert.strictEqual(isSshAgentMountError(stderr), true);
	});

	test('matches generic ssh-agent socket path', () => {
		const stderr =
			'invalid mount config for type "bind": stat /run/user/1000/ssh-agent.sock: permission denied';
		assert.strictEqual(isSshAgentMountError(stderr), true);
	});

	test('does not match unrelated docker bind-mount failures', () => {
		const stderr =
			'invalid mount config for type "bind": stat /workspace/foo.txt: no such file or directory';
		assert.strictEqual(isSshAgentMountError(stderr), false);
	});

	test('does not match unrelated permission denied', () => {
		const stderr =
			'Error: permission denied while reading /etc/shadow';
		assert.strictEqual(isSshAgentMountError(stderr), false);
	});

	test('returns false on empty input', () => {
		assert.strictEqual(isSshAgentMountError(''), false);
	});
});

suite('prepareSpawnEnv', () => {
	const readable = async (): Promise<boolean> => true;
	const unreadable = async (): Promise<boolean> => false;
	const noLog = (): void => {
		throw new Error('logStrip should not be called when nothing is stripped');
	};

	test('returns env unchanged when SSH_AUTH_SOCK is not set', async () => {
		const env = await prepareSpawnEnv({ FOO: 'bar' }, true, readable, noLog);
		assert.strictEqual(env.SSH_AUTH_SOCK, undefined);
		assert.strictEqual(env.FOO, 'bar');
	});

	test('forwardSshAgent=false strips SSH_AUTH_SOCK without probing', async () => {
		let probed = false;
		const env = await prepareSpawnEnv(
			{ SSH_AUTH_SOCK: '/tmp/sock', FOO: 'bar' },
			false,
			async () => {
				probed = true;
				return true;
			},
			() => {},
		);
		assert.strictEqual(env.SSH_AUTH_SOCK, undefined);
		assert.strictEqual(env.FOO, 'bar');
		assert.strictEqual(probed, false, 'should not probe when forwarding is disabled');
	});

	test('forwardSshAgent=true + readable sock forwards unchanged and does not log', async () => {
		const env = await prepareSpawnEnv(
			{ SSH_AUTH_SOCK: '/tmp/sock' },
			true,
			readable,
			noLog,
		);
		assert.strictEqual(env.SSH_AUTH_SOCK, '/tmp/sock');
	});

	test('forwardSshAgent=true + unreadable sock strips and logs once with sock path', async () => {
		const logged: string[] = [];
		const env = await prepareSpawnEnv(
			{ SSH_AUTH_SOCK: '/tmp/cursor-remote-ssh-auth-sock-abc.sock' },
			true,
			unreadable,
			path => logged.push(path),
		);
		assert.strictEqual(env.SSH_AUTH_SOCK, undefined);
		assert.deepStrictEqual(logged, ['/tmp/cursor-remote-ssh-auth-sock-abc.sock']);
	});

	test('does not mutate caller-supplied env object', async () => {
		const base = { SSH_AUTH_SOCK: '/tmp/sock', KEEP: 'me' };
		await prepareSpawnEnv(base, false, readable, () => {});
		assert.strictEqual(base.SSH_AUTH_SOCK, '/tmp/sock');
		assert.strictEqual(base.KEEP, 'me');
	});
});
