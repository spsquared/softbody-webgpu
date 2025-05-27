/**
 * Simple lock (if used wrong it's your problem)
 */
export class AsyncLock {
    private locked = false;
    private readonly queue: (() => void)[] = [];

    async acquire(): Promise<void> {
        if (this.locked) return new Promise<void>((resolve) => {
            this.queue.push(() => resolve());
        });
        this.locked = true;
    }

    release(): void {
        if (this.queue.length > 0) this.queue.shift()?.call(this);
        else this.locked = false;
    }
}