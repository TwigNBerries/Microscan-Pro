/**
 * Depth filter worker entry. One message = one tile.
 * Message in:  { label, buffer: ArrayBuffer, w, h, config }
 * Message out: { label, buffer: ArrayBuffer (filtered) }
 * or:          { label, error: string }
 *
 * Uses transferable ArrayBuffers — no copy at the boundary.
 */

import { applyPipeline, FilterConfig } from './depthFilters';

type InMsg  = { label: string; buffer: ArrayBuffer; w: number; h: number; config: FilterConfig };
type OutOk  = { label: string; buffer: ArrayBuffer };
type OutErr = { label: string; error: string };

self.onmessage = (ev: MessageEvent<InMsg>) => {
  const { label, buffer, w, h, config } = ev.data;
  try {
    const src = new Float32Array(buffer);
    const filtered = applyPipeline(src, w, h, config);
    const out: OutOk = { label, buffer: filtered.buffer };
    (self as unknown as Worker).postMessage(out, [filtered.buffer]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const out: OutErr = { label, error: msg };
    (self as unknown as Worker).postMessage(out);
  }
};

export {};  // make this a module file
