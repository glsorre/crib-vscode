import * as assert from 'assert';
import { RebuildQueue } from '../rebuildQueue';

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

suite('RebuildQueue', () => {
	test('serializes concurrent run() so work never overlaps', async () => {
		const q = new RebuildQueue();
		const order: number[] = [];
		let overlap = 0;
		let depth = 0;
		const mk = (id: number) => async () => {
			depth++;
			overlap = Math.max(overlap, depth);
			order.push(id);
			await sleep(5);
			depth--;
			order.push(-id);
		};
		await Promise.all([q.run(mk(1)), q.run(mk(2))]);
		assert.strictEqual(overlap, 1, 'two jobs should never execute concurrently');
		assert.deepStrictEqual(order, [1, -1, 2, -2], 'second job should run after the first fully completes');
	});

	test('rejected job still allows the next run to execute', async () => {
		const q = new RebuildQueue();
		let secondRan = false;
		await assert.rejects(q.run(async () => { throw new Error('boom'); }), /boom/);
		await q.run(async () => {
			secondRan = true;
		});
		assert.strictEqual(secondRan, true);
	});
});
