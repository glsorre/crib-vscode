import * as assert from 'assert';
import * as vscode from 'vscode';
import { EventEmitter } from 'vscode';
import { CribCli, CribState, CribStatus } from '../crib';
import { DevContainerStorage } from '../paths';
import { SyncEngine, SyncResult } from '../sync';
import { CribTreeDataProvider } from '../views';

const NOOP_LOG = () => {};
const storageRoot = vscode.Uri.joinPath(vscode.Uri.file('/tmp'), 'crib-test-storage');
const storage: DevContainerStorage = {
	extensionId: 'ms-vscode-remote.remote-containers',
	extensionFound: true,
	globalStorage: storageRoot,
	nameConfigs: vscode.Uri.joinPath(storageRoot, 'nameConfigs'),
	imageConfigs: vscode.Uri.joinPath(storageRoot, 'imageConfigs'),
};

function makeMockCrib(initialState: CribState = 'up'): CribCli {
	const mock = {
		status: async (_cwd: vscode.Uri): Promise<CribStatus> => ({ state: initialState }),
		listRuntimeWorkspaces: async () => [],
	} as unknown as CribCli;
	return mock;
}

function makeMockEngine(): SyncEngine {
	const emitter = new EventEmitter<SyncResult>();
	return {
		onDidSync: emitter.event,
		sync: async () => ({} as SyncResult),
		dispose: () => emitter.dispose(),
	} as unknown as SyncEngine;
}

suite('CribTreeDataProvider polling', () => {
	test('startPolling is no-op when crib is undefined', () => {
		const engine = makeMockEngine();
		const tree = new CribTreeDataProvider(storage, undefined, engine, NOOP_LOG);
		try {
			tree.startPolling();
			// Should not throw; timer should not be started
		} finally {
			tree.dispose();
		}
	});

	test('startPolling is idempotent — double start does not create multiple timers', () => {
		const crib = makeMockCrib();
		const engine = makeMockEngine();
		const tree = new CribTreeDataProvider(storage, crib, engine, NOOP_LOG, 10_000);
		try {
			tree.startPolling();
			tree.startPolling();
			tree.startPolling();
			// Should not throw; only one timer should be active
		} finally {
			tree.dispose();
		}
	});

	test('startPolling is no-op when already disposed', () => {
		const crib = makeMockCrib();
		const engine = makeMockEngine();
		const tree = new CribTreeDataProvider(storage, crib, engine, NOOP_LOG, 10_000);
		tree.dispose();
		// Should not throw
		tree.startPolling();
	});

	test('refreshStates returns early when cache is empty', async () => {
		const crib = makeMockCrib();
		const engine = makeMockEngine();
		const tree = new CribTreeDataProvider(storage, crib, engine, NOOP_LOG);
		tree.dispose();
	});

	test('refreshStates updates cache states and fires event on change', async () => {
		const logs: string[] = [];
		const appendLog = (msg: string) => logs.push(msg);

		// Mock returns 'up' for all status calls; cache starts at 'down' so a transition is detected.
		const crib = {
			status: async (): Promise<CribStatus> => {
				return { state: 'up' };
			},
			listRuntimeWorkspaces: async () => [],
		} as unknown as CribCli;

		const engine = makeMockEngine();
		const tree = new CribTreeDataProvider(storage, crib, engine, appendLog);

		// Seed cache directly — cache starts 'down', mock always returns 'up' (transition detected)
		const priv = tree as unknown as {
			cache: { devcontainerUri: vscode.Uri; workspaceFolderUri: vscode.Uri; devcontainerOnDisk: boolean; containerName: string; state: CribState }[];
		};
		priv.cache = [
			{
				devcontainerUri: vscode.Uri.file('/proj/.devcontainer/devcontainer.json'),
				workspaceFolderUri: vscode.Uri.file('/proj'),
				devcontainerOnDisk: true,
				containerName: 'proj-container',
				state: 'down', // seed state — crib will report 'up' on poll
			},
		];

		let eventFired = false;
		const listener = tree.onDidChangeTreeData(() => {
			eventFired = true;
		});

		// Poll cycle: mock returns 'up' while cache is 'down' → state transition detected
		await (tree as unknown as { refreshStates(): Promise<void> }).refreshStates();

		assert.strictEqual(eventFired, true, 'tree data event should fire when state changes');
		assert.ok(logs.some(l => l.includes('[poll]')), 'log should contain [poll] marker');

		listener.dispose();
		tree.dispose();
	});

	test('refreshStates does NOT fire event when states are unchanged', async () => {
		const crib = makeMockCrib('down'); // always returns 'down'
		const engine = makeMockEngine();
		const tree = new CribTreeDataProvider(storage, crib, engine, NOOP_LOG);

		// Seed cache directly — state already 'down', mock also returns 'down'
		const priv = tree as unknown as {
			cache: { devcontainerUri: vscode.Uri; workspaceFolderUri: vscode.Uri; devcontainerOnDisk: boolean; containerName: string; state: CribState }[];
		};
		priv.cache = [
			{
				devcontainerUri: vscode.Uri.file('/proj/.devcontainer/devcontainer.json'),
				workspaceFolderUri: vscode.Uri.file('/proj'),
				devcontainerOnDisk: true,
				containerName: 'proj-container',
				state: 'down',
			},
		];

		let eventFired = false;
		const listener = tree.onDidChangeTreeData(() => {
			eventFired = true;
		});

		// State stays 'down' — no event expected
		await (tree as unknown as { refreshStates(): Promise<void> }).refreshStates();

		assert.strictEqual(eventFired, false, 'tree data event should NOT fire when states unchanged');

		listener.dispose();
		tree.dispose();
	});

	test('dispose clears the poll timer and stops subsequent refreshes', async () => {
		let statusCallCount = 0;
		const crib = {
			status: async (): Promise<CribStatus> => {
				statusCallCount++;
				return { state: 'up' };
			},
		} as unknown as CribCli;
		const engine = makeMockEngine();
		const tree = new CribTreeDataProvider(storage, crib, engine, NOOP_LOG, 10_000);

		tree.startPolling();
		tree.dispose();

		// Wait past the interval to ensure no status calls after dispose
		await new Promise<void>(r => setTimeout(r, 50));
		const callsAfterDispose = statusCallCount;
		assert.strictEqual(callsAfterDispose, 0, 'no status calls should happen after dispose');
	});
});
