import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { ReportError } from './filters.js';

export const EXECUTION_LIMITS = Object.freeze({ maxQueued: 2, timeoutMs: 60000, heapMb: 256 });
const supported = new Set(['node:sqlite', 'better-sqlite3', 'bun:sqlite']);

// One process-wide scheduler survives Next HMR and is shared by both routes.
// A fresh worker/connection per job observes live commits and drops all caches.
export class ReportExecutor {
  constructor({ workerPath = path.join(process.cwd(), 'src/lib/usage-reports/worker.mjs'),
    timeoutMs = EXECUTION_LIMITS.timeoutMs, makeWorker = (file, options) => new Worker(file, options) } = {}) {
    this.workerPath = workerPath;
    this.timeoutMs = timeoutMs;
    this.makeWorker = makeWorker;
    this.queue = [];
    this.active = null;
    this.closed = false;
  }

  execute({ driver, filePath, filters, fullExport = false }, { signal } = {}) {
    if (!supported.has(driver)) return Promise.reject(new ReportError(
      'Isolated usage reports require native SQLite (node:sqlite, better-sqlite3 or bun:sqlite); sql.js reporting is unavailable. Use a native SQLite runtime.', 503));
    if (this.closed) return Promise.reject(new ReportError('Usage reporting is shutting down', 503));
    if (signal?.aborted) return Promise.reject(new ReportError('Usage report cancelled', 499));
    if (this.active && this.queue.length >= EXECUTION_LIMITS.maxQueued) {
      return Promise.reject(new ReportError('Usage reporting is busy; retry shortly', 503));
    }
    return new Promise((resolve, reject) => {
      const job = { data: { driver, filePath, filters, fullExport }, resolve, reject, signal, worker: null, settled: false };
      job.cancel = () => this.cancel(job, new ReportError('Usage report cancelled', 499));
      // Deadline includes time spent waiting in the queue, not just SQL time.
      job.timer = setTimeout(() => this.cancel(job, new ReportError('Usage report timed out; narrow the filters and retry', 504)), this.timeoutMs);
      signal?.addEventListener('abort', job.cancel, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  settle(job, error, bytes) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.cancel);
    if (error) job.reject(error); else job.resolve(bytes);
  }

  cancel(job, error) {
    if (job.settled) return;
    this.settle(job, error);
    if (job === this.active) {
      // Do not release the slot until exit. terminate() cannot interrupt native
      // SQLite immediately on every runtime; replacement workers must not pile up.
      if (job.worker) this.terminate(job);
    } else {
      this.queue = this.queue.filter((queued) => queued !== job);
    }
  }

  terminate(job) {
    if (job.terminating) return;
    job.terminating = true;
    try {
      Promise.resolve(job.worker.terminate()).catch(() => {
        // Fail closed: retain the active slot until an actual exit event.
      });
    } catch {
      // A runtime termination failure must not escape the abort/event handler.
      // Keep the slot occupied until exit; queued jobs still have deadlines.
    }
  }

  pump() {
    if (this.closed || this.active || !this.queue.length) return;
    const job = this.queue.shift();
    this.active = job;
    try {
      job.worker = this.makeWorker(this.workerPath, {
        workerData: job.data, env: {}, execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: EXECUTION_LIMITS.heapMb, maxYoungGenerationSizeMb: 32 },
      });
    } catch {
      this.active = null;
      this.settle(job, new ReportError('Unable to start isolated usage reporting', 503));
      this.pump();
      return;
    }
    job.worker.once('message', (message) => {
      if (message?.bytes instanceof ArrayBuffer) job.result = new Uint8Array(message.bytes);
      else if (message?.error && [400, 413, 500].includes(message.error.status)) {
        // Only fixed worker errors are expected; unexpected exceptions never IPC.
        job.error = new ReportError(message.error.message, message.error.status);
      } else job.error = new ReportError('Unable to generate usage report', 500);
      this.terminate(job);
    });
    job.worker.once('error', () => {
      job.error = new ReportError('Isolated usage reporting failed', 500);
      this.terminate(job);
    });
    job.worker.once('exit', () => {
      this.settle(job, job.error || (!job.result ? new ReportError('Isolated usage reporting stopped unexpectedly', 500) : null), job.result);
      this.active = null;
      this.pump();
    });
  }

  async close() {
    this.closed = true;
    for (const job of [...this.queue]) this.cancel(job, new ReportError('Usage reporting is shutting down', 503));
    if (this.active) {
      const job = this.active;
      const exited = new Promise((resolve) => job.worker.once('exit', resolve));
      this.cancel(job, new ReportError('Usage reporting is shutting down', 503));
      // A successful result can have arrived but not exited yet.
      this.terminate(job);
      await exited;
    }
  }
}

export function executeReport(data, options) {
  const key = Symbol.for('9router.usage-report-executor');
  globalThis[key] ||= new ReportExecutor();
  return globalThis[key].execute(data, options);
}
