// Bounded Job Queue - Local Concurrency Control
// Limits number of concurrent async operations

export interface QueueTask<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: any) => void;
  signal?: AbortSignal;
}

export class BoundedQueue {
  private queue: QueueTask<any>[] = [];
  private running = 0;
  private readonly maxConcurrency: number;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * Run a single task with concurrency limit
   */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, signal });
      this.processQueue();
    });
  }

  /**
   * Run multiple tasks in parallel (respecting concurrency limit)
   */
  async runMany<T>(fns: Array<() => Promise<T>>, signal?: AbortSignal): Promise<T[]> {
    return Promise.all(fns.map(fn => this.run(fn, signal)));
  }

  /**
   * Process queued tasks up to concurrency limit
   */
  private processQueue(): void {
    try {
      while (this.running < this.maxConcurrency && this.queue.length > 0) {
        const task = this.queue.shift();

        if (!task) {
          console.error(`❌ BOUNDED QUEUE ERROR: queue.shift() returned undefined`);
          console.error(`   Queue state: running=${this.running}, queued=${this.queue.length}, max=${this.maxConcurrency}`);
          break;
        }

        // Check if task was aborted before starting
        if (task.signal?.aborted) {
          task.reject(new Error('Task aborted before execution'));
          continue;
        }

        this.running++;

        task.fn()
          .then(result => {
            task.resolve(result);
          })
          .catch(error => {
            console.error(`❌ BOUNDED QUEUE TASK ERROR:`);
            console.error(`   Error type: ${typeof error}`);
            console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
            console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
            console.error(`   Queue state: running=${this.running}, queued=${this.queue.length}`);
            task.reject(error);
          })
          .finally(() => {
            this.running--;
            this.processQueue(); // Process next task
          });
      }
    } catch (error) {
      console.error(`❌ BOUNDED QUEUE PROCESS ERROR:`);
      console.error(`   Error type: ${typeof error}`);
      console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
      console.error(`   Queue state: running=${this.running}, queued=${this.queue.length}, max=${this.maxConcurrency}`);
    }
  }

  /**
   * Get current queue stats
   */
  getStats(): { running: number; queued: number; maxConcurrency: number } {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrency: this.maxConcurrency,
    };
  }

  /**
   * Clear all queued tasks (does not cancel running tasks)
   */
  clear(): void {
    try {
      const cleared = this.queue.length;
      this.queue.forEach(task => {
        try {
          task.reject(new Error('Queue cleared'));
        } catch (error) {
          console.error(`❌ BOUNDED QUEUE CLEAR TASK ERROR:`);
          console.error(`   Error rejecting task:`, error);
        }
      });
      this.queue = [];
      jobLog(`🧹 Cleared ${cleared} queued tasks`);
    } catch (error) {
      console.error(`❌ BOUNDED QUEUE CLEAR ERROR:`);
      console.error(`   Error type: ${typeof error}`);
      console.error(`   Error message: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`   Error stack:`, error instanceof Error ? error.stack : 'N/A');
    }
  }
}
