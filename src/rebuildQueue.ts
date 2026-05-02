/**
 * Serializes async rebuild work so concurrent callers await the same chain
 * instead of racing (e.g. TreeDataProvider#getChildren overlapping on slow SSH).
 */
export class RebuildQueue {
	private chain: Promise<void> = Promise.resolve();

	/**
	 * Run `fn` after all previously enqueued work. The returned promise rejects if `fn`
	 * rejects (direct awaiters should handle); `this.chain` swallows so later jobs still run.
	 */
	run(fn: () => Promise<void>): Promise<void> {
		const next = this.chain.then(() => fn());
		this.chain = next.catch(() => {
			/* swallow so queued follow-ups still run */
		});
		return next;
	}
}
