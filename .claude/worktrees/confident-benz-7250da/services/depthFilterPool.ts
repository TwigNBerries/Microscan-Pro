import type { FilterConfig } from './depthFilters';

export type FilterJob = { label: string; src: Float32Array; w: number; h: number };

export type FilterProgress = {
  done: number;
  total: number;
  lastLabel: string;
  failed: string[];
};

export type FilterResult = { label: string; filtered: Float32Array };

export class DepthFilterPool {
  private workers: Worker[] = [];
  private canceled = false;
  private onResultCb: ((r: FilterResult) => void) | null = null;

  constructor(workerCount?: number) {
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const n = Math.max(1, Math.min(4, workerCount ?? cores - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./depthFilterWorker.ts', import.meta.url), { type: 'module' });
      this.workers.push(w);
    }
  }

  run(
    jobs: FilterJob[],
    config: FilterConfig,
    onProgress: (p: FilterProgress) => void,
    onResult: (r: FilterResult) => void,
  ): Promise<FilterProgress> {
    this.onResultCb = onResult;
    const total = jobs.length;
    let done = 0;
    const failed: string[] = [];
    const queue = [...jobs];
    let resolveOuter!: (p: FilterProgress) => void;

    const outer = new Promise<FilterProgress>((resolve) => { resolveOuter = resolve; });

    const dispatch = (worker: Worker) => {
      if (this.canceled || queue.length === 0) return;
      const job = queue.shift()!;
      worker.onmessage = (ev: MessageEvent<{ label: string; buffer?: ArrayBuffer; error?: string }>) => {
        if (this.canceled) return;
        const { label, buffer, error } = ev.data;
        if (error) { failed.push(label); }
        else if (buffer) {
          const filtered = new Float32Array(buffer);
          this.onResultCb?.({ label, filtered });
        }
        done++;
        onProgress({ done, total, lastLabel: label, failed: [...failed] });
        if (done >= total) {
          resolveOuter({ done, total, lastLabel: label, failed });
        } else {
          dispatch(worker);
        }
      };
      const bufCopy = job.src.buffer.slice(0);
      worker.postMessage({
        label: job.label, buffer: bufCopy,
        w: job.w, h: job.h, config,
      }, [bufCopy]);
    };

    for (const w of this.workers) dispatch(w);
    return outer;
  }

  cancel(): void {
    this.canceled = true;
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
