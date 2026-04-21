# Data Processing Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Processing" tab that filters per-tile depth data with Hampel/median/bilateral filters in a Web Worker pool and exports a filtered stitched XYZ, without touching any existing code paths.

**Architecture:** Pure client-side pipeline. A new `services/depthFilters.ts` module holds sentinel-aware filter math. `services/depthFilterWorker.ts` runs that math off the main thread. `services/depthFilterPool.ts` dispatches tiles across `min(cores − 1, 4)` workers with progress and cancel. `services/depthHeatmapCanvas.ts` renders depth arrays to canvas for live preview. `components/DataProcessing.tsx` is the new tab. `App.tsx` gets a new tab button, a `filteredResults` state slice, and evicts stale filtered tiles when a tile is re-analyzed. `services/depthStitcher.ts` and `components/DepthLab.tsx` are untouched — the filtered stitched export just passes `filteredResults` into the existing `stitchDepthToXYZ`.

**Tech Stack:** React 19 + TypeScript + Vite, Web Workers (module type), Float32Array + transferable ArrayBuffers, TailwindCSS for UI, lucide-react for icons, reuse of existing `services/depthStitcher.ts` and `types.ts:DepthResult`.

**Testing:** This project has no automated test runner. Each task uses a browser-console or visual sanity check as the equivalent of a failing-then-passing test. Synthetic verification tiles are constructed inline in the browser devtools; no JS test framework is added. A final end-to-end manual verification task opens filtered output in Gwyddion.

**No backwards-compat debt:** Nothing in this plan touches existing behavior. If any task's diff modifies an existing function body, re-read the task — the plan is explicit about which files are modified and where.

---

## File Structure

### Create

- `services/depthFilters.ts` — `FilterConfig` type, `DEFAULT_FILTER_CONFIG`, `medianFilter`, `hampelFilter`, `bilateralFilter`, `applyPipeline`. Pure math, no DOM or React.
- `services/depthHeatmapCanvas.ts` — `downsample`, `renderDepthToCanvas` using a jet colormap LUT. Uses `CanvasRenderingContext2D`.
- `services/depthFilterWorker.ts` — Web Worker entry. Imports `depthFilters.ts`. Handles one message shape: `{ tile, w, h, config }` → `{ filtered }`. Transferable ArrayBuffers both ways.
- `services/depthFilterPool.ts` — `DepthFilterPool` class: spawns workers, round-robin dispatch, progress callbacks, cancel via `terminate()`.
- `components/DataProcessing.tsx` — the tab component. Holds local state (`previewLabel`, `filterConfig`, `applyInProgress`, `applyProgress`), receives `results`, `filteredResults`, `setFilteredResults`, `grid`, `settings`, `rotateFrames` as props.

### Modify

- `App.tsx`:
  - Extend `activeTab` union with `'processing'`.
  - Add `<Sliders>` lucide import and tab-bar entry.
  - Add `const [filteredResults, setFilteredResults] = useState<Record<string, DepthResult>>({})`.
  - In `handleTriggerDepth` (where a tile is re-analyzed), evict the matching key from `filteredResults`.
  - Render `<DataProcessing .../>` under `activeTab === 'processing'`.

### Do not touch

- `services/depthStitcher.ts`
- `components/DepthLab.tsx`
- `components/StitchingView.tsx`
- `server.ts`, all `services/*.py`, `types.ts`

---

## Task 1: Scaffold `depthFilters.ts` with types and pipeline shell

**Files:**
- Create: `services/depthFilters.ts`

**Purpose:** Lock in the public interface. No filter math yet — `applyPipeline` returns `src` unchanged if all filters are disabled, and delegates to stubs that also return `src` unchanged otherwise. This gives every downstream consumer (worker, pool, component) a stable import surface to build against.

- [ ] **Step 1: Create file with type definitions and default config**

Create `services/depthFilters.ts`:

```ts
/**
 * Depth-map filters (sentinel-aware).
 *
 * Every filter skips the `-1` uncovered-cell sentinel and `NaN` when building
 * a neighborhood sample, and passes them through unchanged if they happen to
 * be the center pixel. This matches the serializer in `depthStitcher.ts`
 * where -1 represents cells no tile covered.
 */

export type HampelConfig    = { enabled: boolean; kernel: 3 | 5 | 7; threshold: number };
export type MedianConfig    = { enabled: boolean; kernel: 3 | 5 | 7 | 9 };
export type BilateralConfig = { enabled: boolean; spatialSigma: number; rangeSigma: number };

export type FilterConfig = {
  hampel:    HampelConfig;
  median:    MedianConfig;
  bilateral: BilateralConfig;
};

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  hampel:    { enabled: true, kernel: 5, threshold: 3.0 },
  median:    { enabled: true, kernel: 3 },
  bilateral: { enabled: true, spatialSigma: 1.5, rangeSigma: 20 },
};

function isValid(z: number): boolean {
  return Number.isFinite(z) && z >= 0;
}

export function medianFilter(
  src: Float32Array, w: number, h: number, kernel: number,
): Float32Array {
  // Stub — real impl in Task 2.
  return new Float32Array(src);
}

export function hampelFilter(
  src: Float32Array, w: number, h: number, kernel: number, threshold: number,
): Float32Array {
  // Stub — real impl in Task 3.
  return new Float32Array(src);
}

export function bilateralFilter(
  src: Float32Array, w: number, h: number, spatialSigma: number, rangeSigma: number,
): Float32Array {
  // Stub — real impl in Task 4.
  return new Float32Array(src);
}

export function applyPipeline(
  src: Float32Array, w: number, h: number, config: FilterConfig,
): Float32Array {
  let out = src;
  if (config.hampel.enabled) {
    out = hampelFilter(out, w, h, config.hampel.kernel, config.hampel.threshold);
  }
  if (config.median.enabled) {
    out = medianFilter(out, w, h, config.median.kernel);
  }
  if (config.bilateral.enabled) {
    out = bilateralFilter(out, w, h, config.bilateral.spatialSigma, config.bilateral.rangeSigma);
  }
  return out;
}
```

- [ ] **Step 2: Sanity check that the module compiles**

Run Vite build/typecheck (whatever the project uses to catch TS errors). There's no package.json in the worktree — run from the repo root:

```
cd C:/Users/jonah/Downloads/Microscan-Pro-main/Microscan-Pro-main && npx tsc --noEmit
```

Expected: exit 0 (no TypeScript errors for the new file). Pre-existing errors elsewhere are OK — only regressions from this change are failures.

- [ ] **Step 3: Commit**

```
git add services/depthFilters.ts
git commit -m "feat: scaffold depthFilters module with FilterConfig and pipeline shell"
```

---

## Task 2: Implement `medianFilter`

**Files:**
- Modify: `services/depthFilters.ts` (replace the `medianFilter` stub)

**Purpose:** Replace each pixel with the median of its K×K neighborhood, skipping `-1` / NaN samples, mirror-padding borders, passing through sentinel centers. Uses direct partial sort — simple and fast enough for our tile sizes at worker-parallelism ≥ 4.

- [ ] **Step 1: Implement `medianFilter`**

Replace the `medianFilter` stub with:

```ts
export function medianFilter(
  src: Float32Array, w: number, h: number, kernel: number,
): Float32Array {
  const out = new Float32Array(src.length);
  const r = (kernel - 1) >> 1;
  const bufCap = kernel * kernel;
  const buf = new Float64Array(bufCap);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const center = src[y * w + x];
      if (!isValid(center)) { out[y * w + x] = center; continue; }
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        let sy = y + dy;
        if (sy < 0) sy = -sy;
        else if (sy >= h) sy = 2 * h - 2 - sy;
        for (let dx = -r; dx <= r; dx++) {
          let sx = x + dx;
          if (sx < 0) sx = -sx;
          else if (sx >= w) sx = 2 * w - 2 - sx;
          const s = src[sy * w + sx];
          if (isValid(s)) buf[n++] = s;
        }
      }
      if (n === 0) { out[y * w + x] = center; continue; }
      // Partial sort up to n
      for (let i = 1; i < n; i++) {
        const v = buf[i]; let j = i - 1;
        while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
        buf[j + 1] = v;
      }
      out[y * w + x] = (n & 1) ? buf[n >> 1] : 0.5 * (buf[(n >> 1) - 1] + buf[n >> 1]);
    }
  }
  return out;
}
```

- [ ] **Step 2: Browser-console sanity check (checkerboard flattens to ~mid)**

Start the dev server (`npm run dev` from repo root), open the app, then paste into browser devtools console:

```js
const { medianFilter } = await import('/src/services/depthFilters.ts');
const w = 8, h = 8;
const src = new Float32Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src[y*w+x] = ((x + y) & 1) ? 900 : 100;
const out = medianFilter(src, w, h, 3);
console.log('center cells should all be 500:', Array.from(out.slice(w*3+1, w*3+7)));
```

Expected: array of six values all equal to `500` (median of alternating 100/900 with mirror-padding gives 500 at interior cells).

Note: if the `/src/` path isn't how your Vite config resolves imports, use `/services/depthFilters.ts` (matches the `@` or root alias in this project — check `vite.config.ts` first).

- [ ] **Step 3: Browser-console sanity check (sentinel passthrough)**

Paste into the same console:

```js
const { medianFilter } = await import('/src/services/depthFilters.ts');
const src = new Float32Array([100, 100, 100,  100, -1, 100,  100, 100, 100]);
const out = medianFilter(src, 3, 3, 3);
console.log('center stays -1:', out[4], '→ expected -1');
console.log('neighbor of -1:', out[1], '→ expected 100 (not dragged negative)');
```

Expected:
- `out[4]` logs `-1`.
- `out[1]` logs `100`.

- [ ] **Step 4: Commit**

```
git add services/depthFilters.ts
git commit -m "feat: implement sentinel-aware medianFilter"
```

---

## Task 3: Implement `hampelFilter`

**Files:**
- Modify: `services/depthFilters.ts` (replace the `hampelFilter` stub)

**Purpose:** Spike-surgical filter — only replace a pixel if it's more than `threshold × 1.4826 × MAD` away from its neighborhood median. Everything else passes through unchanged.

- [ ] **Step 1: Implement `hampelFilter`**

Replace the `hampelFilter` stub with:

```ts
export function hampelFilter(
  src: Float32Array, w: number, h: number, kernel: number, threshold: number,
): Float32Array {
  const out = new Float32Array(src.length);
  const r = (kernel - 1) >> 1;
  const bufCap = kernel * kernel;
  const buf = new Float64Array(bufCap);
  const devBuf = new Float64Array(bufCap);
  const K = 1.4826;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const center = src[y * w + x];
      if (!isValid(center)) { out[y * w + x] = center; continue; }
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        let sy = y + dy;
        if (sy < 0) sy = -sy;
        else if (sy >= h) sy = 2 * h - 2 - sy;
        for (let dx = -r; dx <= r; dx++) {
          let sx = x + dx;
          if (sx < 0) sx = -sx;
          else if (sx >= w) sx = 2 * w - 2 - sx;
          const s = src[sy * w + sx];
          if (isValid(s)) buf[n++] = s;
        }
      }
      if (n < 3) { out[y * w + x] = center; continue; }
      for (let i = 1; i < n; i++) {
        const v = buf[i]; let j = i - 1;
        while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
        buf[j + 1] = v;
      }
      const med = (n & 1) ? buf[n >> 1] : 0.5 * (buf[(n >> 1) - 1] + buf[n >> 1]);
      for (let i = 0; i < n; i++) devBuf[i] = Math.abs(buf[i] - med);
      for (let i = 1; i < n; i++) {
        const v = devBuf[i]; let j = i - 1;
        while (j >= 0 && devBuf[j] > v) { devBuf[j + 1] = devBuf[j]; j--; }
        devBuf[j + 1] = v;
      }
      const mad = (n & 1) ? devBuf[n >> 1] : 0.5 * (devBuf[(n >> 1) - 1] + devBuf[n >> 1]);
      const sigma = K * mad;
      out[y * w + x] = Math.abs(center - med) > threshold * sigma ? med : center;
    }
  }
  return out;
}
```

- [ ] **Step 2: Browser-console sanity check (spike replaced, rest untouched)**

Paste into devtools console:

```js
const { hampelFilter } = await import('/src/services/depthFilters.ts');
const w = 8, h = 8;
const src = new Float32Array(w * h).fill(500);
src[4 * w + 4] = 50000;                     // inject a huge spike
const out = hampelFilter(src, w, h, 5, 3.0);
console.log('spike cell:', out[4 * w + 4], '→ expected 500');
console.log('neighbor cell:', out[4 * w + 3], '→ expected 500');
console.log('corner cell:', out[0], '→ expected 500');
```

Expected: all three log `500`.

- [ ] **Step 3: Browser-console sanity check (no-op when no spike exists)**

```js
const { hampelFilter } = await import('/src/services/depthFilters.ts');
const w = 8, h = 8;
const src = new Float32Array(w * h);
for (let i = 0; i < src.length; i++) src[i] = 500 + (Math.random() - 0.5) * 0.01;  // tiny Gaussian noise
const out = hampelFilter(src, w, h, 5, 3.0);
let changed = 0;
for (let i = 0; i < src.length; i++) if (out[i] !== src[i]) changed++;
console.log('pixels changed:', changed, '→ expected 0');
```

Expected: `pixels changed: 0`. If any are changed, threshold logic is wrong.

- [ ] **Step 4: Commit**

```
git add services/depthFilters.ts
git commit -m "feat: implement sentinel-aware hampelFilter with MAD-based outlier detection"
```

---

## Task 4: Implement `bilateralFilter`

**Files:**
- Modify: `services/depthFilters.ts` (replace the `bilateralFilter` stub)

**Purpose:** Edge-preserving smoothing. Weighted average of neighborhood where the weight combines a Gaussian over spatial distance and a Gaussian over depth difference. Preserves triangle edges by down-weighting samples across big depth jumps.

- [ ] **Step 1: Implement `bilateralFilter`**

Replace the `bilateralFilter` stub with:

```ts
export function bilateralFilter(
  src: Float32Array, w: number, h: number, spatialSigma: number, rangeSigma: number,
): Float32Array {
  const out = new Float32Array(src.length);
  const r = Math.min(7, Math.max(1, Math.round(3 * spatialSigma)));
  const twoSs2 = 2 * spatialSigma * spatialSigma;
  const twoSr2 = 2 * rangeSigma * rangeSigma;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const center = src[y * w + x];
      if (!isValid(center)) { out[y * w + x] = center; continue; }
      let wsum = 0;
      let vsum = 0;
      for (let dy = -r; dy <= r; dy++) {
        let sy = y + dy;
        if (sy < 0) sy = -sy;
        else if (sy >= h) sy = 2 * h - 2 - sy;
        for (let dx = -r; dx <= r; dx++) {
          let sx = x + dx;
          if (sx < 0) sx = -sx;
          else if (sx >= w) sx = 2 * w - 2 - sx;
          const s = src[sy * w + sx];
          if (!isValid(s)) continue;
          const ws = Math.exp(-(dx * dx + dy * dy) / twoSs2);
          const dz = s - center;
          const wr = Math.exp(-(dz * dz) / twoSr2);
          const wt = ws * wr;
          wsum += wt;
          vsum += s * wt;
        }
      }
      out[y * w + x] = wsum > 0 ? vsum / wsum : center;
    }
  }
  return out;
}
```

- [ ] **Step 2: Browser-console sanity check (flat surface stays flat)**

```js
const { bilateralFilter } = await import('/src/services/depthFilters.ts');
const w = 8, h = 8;
const src = new Float32Array(w * h).fill(500);
const out = bilateralFilter(src, w, h, 1.5, 20);
let maxDiff = 0;
for (let i = 0; i < src.length; i++) maxDiff = Math.max(maxDiff, Math.abs(out[i] - 500));
console.log('max deviation from 500:', maxDiff, '→ expected < 1e-3');
```

Expected: `max deviation from 500: <small number>` (under 0.001).

- [ ] **Step 3: Browser-console sanity check (edge preserved)**

```js
const { bilateralFilter } = await import('/src/services/depthFilters.ts');
const w = 8, h = 8;
const src = new Float32Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src[y*w+x] = x < 4 ? 100 : 900;
const out = bilateralFilter(src, w, h, 1.5, 20);
console.log('left side (should stay near 100):', out[4 * w + 2]);
console.log('right side (should stay near 900):', out[4 * w + 5]);
console.log('edge left (should stay near 100):', out[4 * w + 3]);
console.log('edge right (should stay near 900):', out[4 * w + 4]);
```

Expected: left-side values within a few units of 100, right-side values within a few units of 900. Bilateral with rangeSigma=20 and depth jump of 800 must not bleed across the edge.

- [ ] **Step 4: Commit**

```
git add services/depthFilters.ts
git commit -m "feat: implement sentinel-aware bilateralFilter with edge preservation"
```

---

## Task 5: Wire applyPipeline end-to-end

**Files:**
- Modify: `services/depthFilters.ts` (re-verify `applyPipeline`; no code change expected)

**Purpose:** Confirm the already-written `applyPipeline` correctly chains real implementations. No source change if Task 1 was written correctly — this is a verification checkpoint.

- [ ] **Step 1: Browser-console sanity check (full pipeline on ramp preserves slope)**

```js
const { applyPipeline, DEFAULT_FILTER_CONFIG } = await import('/src/services/depthFilters.ts');
const w = 16, h = 16;
const src = new Float32Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src[y*w+x] = x * 60;  // ramp 0-900
const out = applyPipeline(src, w, h, DEFAULT_FILTER_CONFIG);
console.log('ramp start (should be near 0):', out[w * 8 + 0]);
console.log('ramp mid (should be near 420):', out[w * 8 + 7]);
console.log('ramp end (should be near 900):', out[w * 8 + 15]);
```

Expected: values within ±5 of the target. Edges may be slightly pulled in by mirror-padding; that's acceptable.

- [ ] **Step 2: Commit (checkpoint only — no code change)**

If Tasks 1-4 were committed correctly, there's nothing new to add here. Skip the commit.

---

## Task 6: Implement `depthHeatmapCanvas.ts`

**Files:**
- Create: `services/depthHeatmapCanvas.ts`

**Purpose:** Client-side canvas renderer for depth preview. Downsample for speed, colormap via a 256-entry jet LUT.

- [ ] **Step 1: Create the module**

Create `services/depthHeatmapCanvas.ts`:

```ts
/**
 * Client-side heatmap renderer for DepthResult.depthValues.
 * Used by the Processing tab preview — mirrors the visual style of the
 * existing Python-generated heatmap JPEGs closely enough to compare.
 */

const JET_LUT = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r: number, g: number, b: number;
    if (t < 0.125) { r = 0; g = 0; b = 0.5 + 4 * t; }
    else if (t < 0.375) { r = 0; g = 4 * (t - 0.125); b = 1; }
    else if (t < 0.625) { r = 4 * (t - 0.375); g = 1; b = 1 - 4 * (t - 0.375); }
    else if (t < 0.875) { r = 1; g = 1 - 4 * (t - 0.625); b = 0; }
    else                { r = 1 - 4 * (t - 0.875); if (r < 0.5) r = 0.5; g = 0; b = 0; }
    lut[i * 3]     = Math.round(255 * Math.max(0, Math.min(1, r)));
    lut[i * 3 + 1] = Math.round(255 * Math.max(0, Math.min(1, g)));
    lut[i * 3 + 2] = Math.round(255 * Math.max(0, Math.min(1, b)));
  }
  return lut;
})();

export function downsample(
  src: Float32Array, w: number, h: number, maxDim: number,
): { data: Float32Array; w: number; h: number } {
  const step = Math.max(1, Math.ceil(Math.max(w, h) / maxDim));
  if (step === 1) return { data: src, w, h };
  const nw = Math.floor(w / step);
  const nh = Math.floor(h / step);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      out[y * nw + x] = src[(y * step) * w + (x * step)];
    }
  }
  return { data: out, w: nw, h: nh };
}

export function renderDepthToCanvas(
  depthValues: Float32Array, w: number, h: number,
  min: number, max: number,
  canvas: HTMLCanvasElement,
): void {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(w, h);
  const range = max - min;
  const invRange = range > 0 ? 1 / range : 0;
  for (let i = 0; i < w * h; i++) {
    const z = depthValues[i];
    const px = i * 4;
    if (!Number.isFinite(z) || z < 0) {
      img.data[px] = 0; img.data[px + 1] = 0; img.data[px + 2] = 0; img.data[px + 3] = 0;
      continue;
    }
    const t = Math.max(0, Math.min(1, (z - min) * invRange));
    const idx = Math.round(t * 255) * 3;
    img.data[px]     = JET_LUT[idx];
    img.data[px + 1] = JET_LUT[idx + 1];
    img.data[px + 2] = JET_LUT[idx + 2];
    img.data[px + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
```

- [ ] **Step 2: Browser-console sanity check**

```js
const { renderDepthToCanvas } = await import('/src/services/depthHeatmapCanvas.ts');
const canvas = document.createElement('canvas');
const w = 64, h = 64;
const data = new Float32Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = x * 10;
renderDepthToCanvas(data, w, h, 0, 640, canvas);
document.body.appendChild(canvas);
canvas.style.border = '1px solid red';
canvas.style.imageRendering = 'pixelated';
canvas.style.width = '320px';
```

Expected: a 320px-wide canvas gets appended to the page showing a horizontal blue-to-red gradient. Remove it manually from the DOM after inspecting (`canvas.remove()`).

- [ ] **Step 3: Commit**

```
git add services/depthHeatmapCanvas.ts
git commit -m "feat: add depthHeatmapCanvas for client-side jet-colormap preview"
```

---

## Task 7: Implement `depthFilterWorker.ts`

**Files:**
- Create: `services/depthFilterWorker.ts`

**Purpose:** Web Worker entry point. Receives a tile's depth buffer + filter config, runs `applyPipeline`, posts back the filtered buffer. Transferable `ArrayBuffer`s in both directions.

- [ ] **Step 1: Create the worker file**

Create `services/depthFilterWorker.ts`:

```ts
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
```

- [ ] **Step 2: Browser-console sanity check**

From devtools console:

```js
const w = new Worker(new URL('/src/services/depthFilterWorker.ts', import.meta.url), { type: 'module' });
const src = new Float32Array(64 * 64).fill(500);
src[32 * 64 + 32] = 50000;
const buf = src.buffer;
w.onmessage = (ev) => {
  if (ev.data.error) { console.error('worker error:', ev.data.error); return; }
  const out = new Float32Array(ev.data.buffer);
  console.log('spike cell after worker filter:', out[32 * 64 + 32], '→ expected 500');
  w.terminate();
};
w.postMessage({
  label: 'A1', buffer: buf, w: 64, h: 64,
  config: {
    hampel:    { enabled: true, kernel: 5, threshold: 3.0 },
    median:    { enabled: false, kernel: 3 },
    bilateral: { enabled: false, spatialSigma: 1.5, rangeSigma: 20 },
  },
}, [buf]);
```

Expected: log shows `spike cell after worker filter: 500`. If `worker error` appears, Vite may not recognize the `/src/` path — swap to a path that matches the project's worker-resolution convention (`./services/...` relative to the calling file normally works).

- [ ] **Step 3: Commit**

```
git add services/depthFilterWorker.ts
git commit -m "feat: add depthFilterWorker for off-thread tile filtering"
```

---

## Task 8: Implement `depthFilterPool.ts`

**Files:**
- Create: `services/depthFilterPool.ts`

**Purpose:** Pool manager. Spawns `min(cores − 1, 4)` workers, dispatches jobs round-robin, reports progress per tile, supports cancel. Results are yielded as each tile completes (incremental updates so cancel mid-run preserves finished work).

- [ ] **Step 1: Create the pool module**

Create `services/depthFilterPool.ts`:

```ts
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
```

- [ ] **Step 2: Browser-console sanity check**

```js
const { DepthFilterPool } = await import('/src/services/depthFilterPool.ts');
const { DEFAULT_FILTER_CONFIG } = await import('/src/services/depthFilters.ts');
const pool = new DepthFilterPool(2);
const jobs = Array.from({ length: 5 }, (_, i) => {
  const src = new Float32Array(128 * 128).fill(500);
  src[64 * 128 + 64] = 50000;
  return { label: `T${i}`, src, w: 128, h: 128 };
});
const results = new Map();
const finalP = await pool.run(jobs, DEFAULT_FILTER_CONFIG,
  (p) => console.log('progress:', p.done, '/', p.total, p.lastLabel),
  (r) => results.set(r.label, r.filtered),
);
console.log('final:', finalP);
console.log('T0 spike cell:', results.get('T0')[64 * 128 + 64], '→ expected 500');
pool.cancel();
```

Expected:
- Progress logs fire once per tile (five total).
- Final state shows `done: 5, total: 5, failed: []`.
- Spike cell in each result is `500`.

- [ ] **Step 3: Commit**

```
git add services/depthFilterPool.ts
git commit -m "feat: add DepthFilterPool with round-robin dispatch and progress callbacks"
```

---

## Task 9: Scaffold `DataProcessing.tsx` (shell + preview dropdown)

**Files:**
- Create: `components/DataProcessing.tsx`

**Purpose:** Component shell with prop types, preview-tile selector, placeholder layout. Wired into App in Task 14; this task just makes the file render in isolation.

- [ ] **Step 1: Create the component shell**

Create `components/DataProcessing.tsx`:

```tsx
import React, { useMemo, useRef, useState } from 'react';
import { DepthResult, GridDimensions, ScanSettings } from '../types';
import { Sliders, Play, X, FileOutput, RotateCcw } from 'lucide-react';
import { FilterConfig, DEFAULT_FILTER_CONFIG } from '../services/depthFilters';

interface Props {
  results: Record<string, DepthResult>;
  filteredResults: Record<string, DepthResult>;
  setFilteredResults: React.Dispatch<React.SetStateAction<Record<string, DepthResult>>>;
  grid: GridDimensions;
  settings: ScanSettings;
}

const DataProcessing: React.FC<Props> = ({
  results, filteredResults, setFilteredResults, grid, settings,
}) => {
  const finishedLabels = useMemo(
    () => Object.keys(results).filter(l => {
      const r = results[l];
      return r && r.dataUrl && !r.isProcessing && r.depthValues.length > 0;
    }).sort(),
    [results],
  );

  const [previewLabel, setPreviewLabel] = useState<string>(finishedLabels[0] ?? '');
  const [filterConfig, setFilterConfig] = useState<FilterConfig>(DEFAULT_FILTER_CONFIG);
  const rawCanvasRef = useRef<HTMLCanvasElement>(null);
  const filteredCanvasRef = useRef<HTMLCanvasElement>(null);

  if (finishedLabels.length === 0) {
    return (
      <div className="py-24 flex flex-col items-center justify-center bg-slate-900/30 rounded-[3rem] border-2 border-dashed border-slate-800 animate-in fade-in duration-500">
        <Sliders className="w-16 h-16 text-slate-800 mb-4" />
        <p className="text-slate-500 font-black uppercase tracking-widest text-xs">
          Analyze tiles in the Depth tab first
        </p>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-500 space-y-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
        <div>
          <h2 className="text-2xl font-black text-white flex items-center gap-3">
            Data Processing
            <span className="px-2 py-0.5 bg-violet-500/10 border border-violet-500/30 text-violet-400 text-[10px] rounded-full font-black uppercase tracking-widest">
              Post-Process
            </span>
          </h2>
          <p className="text-xs text-slate-500 uppercase tracking-widest mt-1">
            Sentinel-aware noise reduction for stitched depth exports
          </p>
        </div>
        <div>
          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 block">
            Preview Tile
          </label>
          <select
            value={previewLabel}
            onChange={(e) => setPreviewLabel(e.target.value)}
            className="mt-1 bg-slate-900 border border-slate-800 text-white text-xs font-bold rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-violet-500/50 outline-none"
          >
            {finishedLabels.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-slate-900/50 border border-slate-800 rounded-[2rem] p-6 space-y-3">
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Raw</p>
          <canvas ref={rawCanvasRef} className="w-full rounded-xl bg-black" style={{ imageRendering: 'pixelated' }} />
        </div>
        <div className="bg-slate-900/50 border border-slate-800 rounded-[2rem] p-6 space-y-3">
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Filtered</p>
          <canvas ref={filteredCanvasRef} className="w-full rounded-xl bg-black" style={{ imageRendering: 'pixelated' }} />
        </div>
      </div>

      <div className="bg-slate-900/50 border border-slate-800 rounded-[2rem] p-6 space-y-4">
        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Controls (filter panels land in Task 11)</p>
      </div>

      <div className="bg-slate-900/50 border border-slate-800 rounded-[2rem] p-6 flex items-center justify-between gap-4">
        <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Apply + export bar lands in Task 12 / 13</p>
      </div>
    </div>
  );
};

export default DataProcessing;
```

- [ ] **Step 2: Verify the file compiles**

```
cd C:/Users/jonah/Downloads/Microscan-Pro-main/Microscan-Pro-main && npx tsc --noEmit
```

Expected: no new TypeScript errors from the new file.

- [ ] **Step 3: Commit**

```
git add components/DataProcessing.tsx
git commit -m "feat: scaffold DataProcessing tab with preview dropdown"
```

---

## Task 10: Wire preview canvases with live filter recomputation

**Files:**
- Modify: `components/DataProcessing.tsx`

**Purpose:** Render the preview tile as a heatmap in the Raw canvas and the filter pipeline output in the Filtered canvas. Recompute whenever `previewLabel` or `filterConfig` changes. Preview uses `downsample` so sliders stay snappy.

- [ ] **Step 1: Add imports and the preview effect**

At the top of `components/DataProcessing.tsx`, extend imports:

```tsx
import React, { useMemo, useRef, useState, useEffect } from 'react';
import { DepthResult, GridDimensions, ScanSettings } from '../types';
import { Sliders, Play, X, FileOutput, RotateCcw } from 'lucide-react';
import { FilterConfig, DEFAULT_FILTER_CONFIG, applyPipeline } from '../services/depthFilters';
import { renderDepthToCanvas, downsample } from '../services/depthHeatmapCanvas';
```

Inside the `DataProcessing` component, above the `if (finishedLabels.length === 0)` branch, add the preview computation:

```tsx
useEffect(() => {
  const r = results[previewLabel];
  if (!r || !r.depthValues.length) return;
  const ds = downsample(r.depthValues, r.width, r.height, 1024);
  const validMin = Math.min(r.minZ * 1000, r.maxZ * 1000);
  const validMax = Math.max(r.minZ * 1000, r.maxZ * 1000);
  if (rawCanvasRef.current) {
    renderDepthToCanvas(ds.data, ds.w, ds.h, validMin, validMax, rawCanvasRef.current);
  }
  if (filteredCanvasRef.current) {
    const filtered = applyPipeline(ds.data, ds.w, ds.h, filterConfig);
    renderDepthToCanvas(filtered, ds.w, ds.h, validMin, validMax, filteredCanvasRef.current);
  }
}, [previewLabel, filterConfig, results]);
```

Note: `r.minZ` / `r.maxZ` are in millimeters (see `types.ts:DepthResult`); `r.depthValues` is in microns (see `services/depthService.ts` line 173). The `* 1000` converts the color scale to microns so it matches `depthValues`.

- [ ] **Step 2: Verify the preview updates**

With the dev server running, click the Processing tab, pick a finished tile. Expected: both canvases show a heatmap. Uncovered cells (if any) should be transparent (canvas background shows through). Changing the preview dropdown should swap both canvases within ~50 ms.

(Since filter controls aren't wired yet, Raw and Filtered should currently look identical.)

- [ ] **Step 3: Commit**

```
git add components/DataProcessing.tsx
git commit -m "feat: wire live preview heatmaps in DataProcessing"
```

---

## Task 11: Wire the three filter control panels

**Files:**
- Modify: `components/DataProcessing.tsx` (replace the "Controls placeholder" div with real controls)

**Purpose:** Three collapsible panels with on/off toggles + sliders. Each change updates `filterConfig`, which triggers the preview effect from Task 10.

- [ ] **Step 1: Add the controls block**

In `components/DataProcessing.tsx`, replace the placeholder controls block:

```tsx
<div className="bg-slate-900/50 border border-slate-800 rounded-[2rem] p-6 space-y-4">
  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Controls (filter panels land in Task 11)</p>
</div>
```

with:

```tsx
<div className="bg-slate-900/50 border border-slate-800 rounded-[2rem] p-6 space-y-5">
  <div className="flex items-center justify-between">
    <p className="text-xs font-black text-white uppercase tracking-widest">Filter Pipeline</p>
    <button
      onClick={() => setFilterConfig(DEFAULT_FILTER_CONFIG)}
      className="text-[10px] font-black text-slate-500 uppercase tracking-widest hover:text-violet-400 transition-all flex items-center gap-1"
    >
      <RotateCcw className="w-3 h-3" /> Reset
    </button>
  </div>

  {/* Hampel */}
  <div className="p-4 bg-slate-950/50 rounded-xl border border-slate-800 space-y-3">
    <label className="flex items-center gap-3 cursor-pointer">
      <input type="checkbox" checked={filterConfig.hampel.enabled}
        onChange={(e) => setFilterConfig(c => ({ ...c, hampel: { ...c.hampel, enabled: e.target.checked } }))}
        className="accent-violet-500 w-4 h-4" />
      <span className="text-xs font-black text-white">1. Hampel — spike removal</span>
    </label>
    <div className="grid grid-cols-2 gap-4 pl-7">
      <label className="block">
        <span className="text-[10px] font-black text-slate-500 uppercase">Kernel: {filterConfig.hampel.kernel}</span>
        <input type="range" min="3" max="7" step="2" value={filterConfig.hampel.kernel}
          onChange={(e) => setFilterConfig(c => ({ ...c, hampel: { ...c.hampel, kernel: Number(e.target.value) as 3 | 5 | 7 } }))}
          className="w-full accent-violet-500" />
      </label>
      <label className="block">
        <span className="text-[10px] font-black text-slate-500 uppercase">Threshold: {filterConfig.hampel.threshold.toFixed(1)}σ</span>
        <input type="range" min="1" max="5" step="0.1" value={filterConfig.hampel.threshold}
          onChange={(e) => setFilterConfig(c => ({ ...c, hampel: { ...c.hampel, threshold: Number(e.target.value) } }))}
          className="w-full accent-violet-500" />
      </label>
    </div>
  </div>

  {/* Median */}
  <div className="p-4 bg-slate-950/50 rounded-xl border border-slate-800 space-y-3">
    <label className="flex items-center gap-3 cursor-pointer">
      <input type="checkbox" checked={filterConfig.median.enabled}
        onChange={(e) => setFilterConfig(c => ({ ...c, median: { ...c.median, enabled: e.target.checked } }))}
        className="accent-violet-500 w-4 h-4" />
      <span className="text-xs font-black text-white">2. Median — general smoothing</span>
    </label>
    <div className="grid grid-cols-2 gap-4 pl-7">
      <label className="block">
        <span className="text-[10px] font-black text-slate-500 uppercase">Kernel: {filterConfig.median.kernel}</span>
        <input type="range" min="3" max="9" step="2" value={filterConfig.median.kernel}
          onChange={(e) => setFilterConfig(c => ({ ...c, median: { ...c.median, kernel: Number(e.target.value) as 3 | 5 | 7 | 9 } }))}
          className="w-full accent-violet-500" />
      </label>
    </div>
  </div>

  {/* Bilateral */}
  <div className="p-4 bg-slate-950/50 rounded-xl border border-slate-800 space-y-3">
    <label className="flex items-center gap-3 cursor-pointer">
      <input type="checkbox" checked={filterConfig.bilateral.enabled}
        onChange={(e) => setFilterConfig(c => ({ ...c, bilateral: { ...c.bilateral, enabled: e.target.checked } }))}
        className="accent-violet-500 w-4 h-4" />
      <span className="text-xs font-black text-white">3. Bilateral — edge-preserving smooth</span>
    </label>
    <div className="grid grid-cols-2 gap-4 pl-7">
      <label className="block">
        <span className="text-[10px] font-black text-slate-500 uppercase">Spatial σ: {filterConfig.bilateral.spatialSigma.toFixed(1)}</span>
        <input type="range" min="0.5" max="3" step="0.1" value={filterConfig.bilateral.spatialSigma}
          onChange={(e) => setFilterConfig(c => ({ ...c, bilateral: { ...c.bilateral, spatialSigma: Number(e.target.value) } }))}
          className="w-full accent-violet-500" />
      </label>
      <label className="block">
        <span className="text-[10px] font-black text-slate-500 uppercase">Range σ: {filterConfig.bilateral.rangeSigma.toFixed(0)} µm</span>
        <input type="range" min="5" max="100" step="1" value={filterConfig.bilateral.rangeSigma}
          onChange={(e) => setFilterConfig(c => ({ ...c, bilateral: { ...c.bilateral, rangeSigma: Number(e.target.value) } }))}
          className="w-full accent-violet-500" />
      </label>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Verify the controls update the preview live**

Load the tab, pick a finished tile. Toggle each checkbox off — the Filtered canvas should visibly change. Drag each slider — the Filtered canvas should update within a frame or two.

- [ ] **Step 3: Commit**

```
git add components/DataProcessing.tsx
git commit -m "feat: add Hampel/Median/Bilateral control panels with live preview"
```

---

## Task 12: Wire "Apply to all tiles" with worker pool and progress bar

**Files:**
- Modify: `components/DataProcessing.tsx` (replace the "Apply bar" placeholder)

**Purpose:** Clicking Apply spawns a `DepthFilterPool`, dispatches every finished tile, updates `filteredResults` incrementally, shows a progress bar, and allows cancel.

- [ ] **Step 1: Extend imports and add Apply state**

At the top of `components/DataProcessing.tsx`, extend the imports line that already pulls from `../services/depthFilters`:

```tsx
import { FilterConfig, DEFAULT_FILTER_CONFIG, applyPipeline } from '../services/depthFilters';
import { DepthFilterPool, FilterProgress } from '../services/depthFilterPool';
```

Inside the component, alongside existing useState calls, add:

```tsx
const [applyInProgress, setApplyInProgress] = useState(false);
const [applyProgress, setApplyProgress] = useState<FilterProgress | null>(null);
const poolRef = useRef<DepthFilterPool | null>(null);
```

Add the handler (above the `return` statement):

```tsx
const handleApplyToAll = async () => {
  if (applyInProgress) return;
  const jobs = finishedLabels
    .filter(l => {
      const r = results[l];
      return r && r.depthValues.length > 0;
    })
    .map(l => {
      const r = results[l];
      return { label: l, src: r.depthValues, w: r.width, h: r.height };
    });
  if (jobs.length === 0) return;

  setApplyInProgress(true);
  setApplyProgress({ done: 0, total: jobs.length, lastLabel: '', failed: [] });

  const pool = new DepthFilterPool();
  poolRef.current = pool;

  try {
    await pool.run(
      jobs,
      filterConfig,
      (p) => setApplyProgress(p),
      (r) => {
        const source = results[r.label];
        if (!source) return;
        let minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < r.filtered.length; i++) {
          const z = r.filtered[i];
          if (Number.isFinite(z) && z >= 0) {
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
          }
        }
        if (!Number.isFinite(minZ)) { minZ = 0; maxZ = 0; }
        setFilteredResults(prev => ({
          ...prev,
          [r.label]: {
            ...source,
            depthValues: r.filtered,
            minZ: minZ / 1000,
            maxZ: maxZ / 1000,
            method: (source.method ?? '') + '+filtered',
          },
        }));
      },
    );
  } finally {
    pool.cancel();
    poolRef.current = null;
    setApplyInProgress(false);
  }
};

const handleCancelApply = () => {
  if (poolRef.current) {
    poolRef.current.cancel();
    poolRef.current = null;
  }
  setApplyInProgress(false);
};

const handleDiscardFiltered = () => {
  setFilteredResults({});
};
```

- [ ] **Step 2: Replace the placeholder bottom bar**

Replace:

```tsx
<div className="bg-slate-900/50 border border-slate-800 rounded-[2rem] p-6 flex items-center justify-between gap-4">
  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Apply + export bar lands in Task 12 / 13</p>
</div>
```

with:

```tsx
<div className="bg-slate-900/50 border border-slate-800 rounded-[2rem] p-6 space-y-4">
  <div className="flex flex-wrap items-center gap-3">
    <button
      onClick={handleApplyToAll}
      disabled={applyInProgress || finishedLabels.length === 0}
      className="px-6 py-3 bg-violet-500 text-white rounded-2xl font-black text-xs shadow-xl flex items-center gap-2 hover:bg-violet-400 transition-all disabled:opacity-30"
    >
      <Play className="w-4 h-4" /> Apply to all tiles ({finishedLabels.length})
    </button>
    {applyInProgress && (
      <button
        onClick={handleCancelApply}
        className="px-6 py-3 bg-rose-500 text-white rounded-2xl font-black text-xs shadow-xl flex items-center gap-2 hover:bg-rose-400 transition-all"
      >
        <X className="w-4 h-4" /> Cancel
      </button>
    )}
    <button
      onClick={handleDiscardFiltered}
      disabled={Object.keys(filteredResults).length === 0 || applyInProgress}
      className="px-6 py-3 bg-slate-800 text-white border border-slate-700 rounded-2xl font-black text-xs hover:bg-slate-700 transition-all disabled:opacity-30"
    >
      Discard Filtered
    </button>
    <span className="text-[10px] text-slate-500 font-black uppercase tracking-widest ml-auto">
      Filtered tiles in memory: {Object.keys(filteredResults).length} / {finishedLabels.length}
    </span>
  </div>

  {applyProgress && (
    <div className="space-y-1">
      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-violet-500 transition-all"
          style={{ width: `${(applyProgress.done / Math.max(1, applyProgress.total)) * 100}%` }}
        />
      </div>
      <p className="text-[10px] text-slate-500 font-black uppercase tracking-widest">
        {applyProgress.done} / {applyProgress.total} — last: {applyProgress.lastLabel || '—'}
        {applyProgress.failed.length > 0 && ` · failed: ${applyProgress.failed.join(', ')}`}
      </p>
    </div>
  )}

  <p className="text-[10px] text-slate-500 uppercase tracking-widest">
    Processing is non-destructive — raw tiles in the Depth tab are never modified.
  </p>
</div>
```

- [ ] **Step 3: Verify end-to-end**

With a real multi-tile scan finished, click **Apply to all tiles**. Expected:
- Progress bar advances smoothly.
- UI stays responsive (try scrolling the page, switching tabs).
- After completion, the label next to the progress bar shows `N / N` and `Filtered tiles in memory: N / N`.
- Cancel mid-run aborts remaining work; finished tiles stay in the in-memory count.

- [ ] **Step 4: Commit**

```
git add components/DataProcessing.tsx
git commit -m "feat: wire apply-to-all with worker pool, progress, and cancel"
```

---

## Task 13: Add "Export Filtered Stitched XYZ" button

**Files:**
- Modify: `components/DataProcessing.tsx`

**Purpose:** Reuse `stitchDepthToXYZ` against `filteredResults`. Download the Blob as `Depth_Filtered_Stitched_<timestamp>.xyz`. Same yield-then-blob pattern as the existing DepthLab handler.

- [ ] **Step 1: Import the stitcher and add state/handler**

At the top of `components/DataProcessing.tsx`, add:

```tsx
import { stitchDepthToXYZ } from '../services/depthStitcher';
import { Loader2 } from 'lucide-react';
```

Accept a new prop (extend the Props interface):

```tsx
interface Props {
  results: Record<string, DepthResult>;
  filteredResults: Record<string, DepthResult>;
  setFilteredResults: React.Dispatch<React.SetStateAction<Record<string, DepthResult>>>;
  grid: GridDimensions;
  settings: ScanSettings;
  rotateFrames: boolean;
}
```

Destructure `rotateFrames` in the component signature:

```tsx
const DataProcessing: React.FC<Props> = ({
  results, filteredResults, setFilteredResults, grid, settings, rotateFrames,
}) => {
```

Add state + handler near the other handlers:

```tsx
const [isExporting, setIsExporting] = useState(false);

const handleExportFilteredStitched = async () => {
  if (isExporting) return;
  if (Object.keys(filteredResults).length === 0) return;
  setIsExporting(true);
  try {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const blob = stitchDepthToXYZ(filteredResults, grid, settings, rotateFrames);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Depth_Filtered_Stitched_${Date.now()}.xyz`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  } catch (err) {
    console.error('Filtered stitched XYZ export failed:', err);
    alert(`Filtered stitched XYZ export failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    setIsExporting(false);
  }
};
```

- [ ] **Step 2: Add the Export button to the bottom bar**

Inside the bottom bar div (the same `<div className="... flex flex-wrap items-center gap-3">`), add after the **Discard Filtered** button and before the `<span>...Filtered tiles in memory...</span>`:

```tsx
<button
  onClick={handleExportFilteredStitched}
  disabled={isExporting || Object.keys(filteredResults).length === 0 || applyInProgress}
  title="Stitch filtered tiles into one XYZ file"
  className="px-6 py-3 bg-amber-500 text-slate-900 rounded-2xl font-black text-xs shadow-xl flex items-center gap-2 hover:bg-amber-400 transition-all disabled:opacity-30"
>
  {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileOutput className="w-4 h-4" />}
  Export Filtered Stitched XYZ
</button>
```

- [ ] **Step 3: Verify the button disables and exports correctly**

With at least one filtered tile in memory, click the button. Expected: download starts, filename begins with `Depth_Filtered_Stitched_`. If `filteredResults` is empty, the button is disabled.

- [ ] **Step 4: Commit**

```
git add components/DataProcessing.tsx
git commit -m "feat: add Export Filtered Stitched XYZ button reusing stitchDepthToXYZ"
```

---

## Task 14: Wire the Processing tab into App.tsx

**Files:**
- Modify: `App.tsx`

**Purpose:** Add the tab union member, the tab-bar button, the shared state, the staleness eviction on re-analyze, and the component render.

- [ ] **Step 1: Extend tab union and add state**

In `App.tsx`, find:

```tsx
const [activeTab, setActiveTab] = useState<'config' | 'jog' | 'manual' | 'verify' | 'gallery' | 'stitching' | 'stacking' | 'depth'>('config');
```

Replace it with:

```tsx
const [activeTab, setActiveTab] = useState<'config' | 'jog' | 'manual' | 'verify' | 'gallery' | 'stitching' | 'stacking' | 'depth' | 'processing'>('config');
const [filteredResults, setFilteredResults] = useState<Record<string, DepthResult>>({});
```

Make sure `DepthResult` is imported at the top of `App.tsx` (it should already be, from DepthLab). If not, extend the `'./types'` import.

- [ ] **Step 2: Add Sliders to the lucide imports**

In the lucide-react import line of `App.tsx`, add `Sliders`:

```tsx
// example — your actual line may list different icons
import { /* existing icons, */ Sliders } from 'lucide-react';
```

- [ ] **Step 3: Add the tab button in the tab bar**

Find the array literal around line 912 of `App.tsx`:

```tsx
{ id: 'stacking', label: 'Stack', icon: Sparkles },
{ id: 'depth', label: 'Depth', icon: Map },
{ id: 'stitching', label: 'Stitch', icon: Combine },
{ id: 'gallery', label: 'Gallery', icon: ImageIcon }
```

Insert a new entry between `depth` and `stitching`:

```tsx
{ id: 'stacking', label: 'Stack', icon: Sparkles },
{ id: 'depth', label: 'Depth', icon: Map },
{ id: 'processing', label: 'Process', icon: Sliders },
{ id: 'stitching', label: 'Stitch', icon: Combine },
{ id: 'gallery', label: 'Gallery', icon: ImageIcon }
```

- [ ] **Step 4: Render the new tab**

Find the block around line 1161:

```tsx
{activeTab === 'depth' && (
  <DepthLab
    results={depthResults}
    capturedImages={groupedCapturedImages}
    onTriggerDepth={handleTriggerDepth}
    onClearDepth={handleClearDepth}
    grid={grid}
    settings={settings}
  />
)}
```

**Locate the `rotateFrames` state in `DepthLab.tsx`** — it's local component state, not lifted. The Processing tab also needs it. Lift it to `App.tsx`: add to the state block:

```tsx
const [rotateFrames, setRotateFrames] = useState(false);
```

Modify `DepthLab` to accept `rotateFrames` / `setRotateFrames` as props instead of owning the state — replace the props interface in `components/DepthLab.tsx`:

```tsx
interface Props {
  results: Record<string, DepthResult>;
  capturedImages: Record<string, CapturedImage[]>;
  onTriggerDepth: (label: string, images: CapturedImage[], method: DepthMethod) => Promise<void>;
  onClearDepth: (label: string) => void;
  grid: GridDimensions;
  settings: ScanSettings;
  rotateFrames: boolean;
  setRotateFrames: React.Dispatch<React.SetStateAction<boolean>>;
}
```

And in the component signature:

```tsx
const DepthLab: React.FC<Props> = ({
  results, capturedImages, onTriggerDepth, onClearDepth, grid, settings,
  rotateFrames, setRotateFrames,
}) => {
```

Remove the existing `const [rotateFrames, setRotateFrames] = useState(false);` line from `DepthLab.tsx`.

Then update the App.tsx render:

```tsx
{activeTab === 'depth' && (
  <DepthLab
    results={depthResults}
    capturedImages={groupedCapturedImages}
    onTriggerDepth={handleTriggerDepth}
    onClearDepth={handleClearDepth}
    grid={grid}
    settings={settings}
    rotateFrames={rotateFrames}
    setRotateFrames={setRotateFrames}
  />
)}
{activeTab === 'processing' && (
  <DataProcessing
    results={depthResults}
    filteredResults={filteredResults}
    setFilteredResults={setFilteredResults}
    grid={grid}
    settings={settings}
    rotateFrames={rotateFrames}
  />
)}
```

Add the DataProcessing import at the top of `App.tsx`:

```tsx
import DataProcessing from './components/DataProcessing';
```

- [ ] **Step 5: Evict stale filtered entries on re-analyze**

Find `handleTriggerDepth` in `App.tsx` (the function that starts a depth analysis for a single tile — the same one passed as `onTriggerDepth` to DepthLab). At the start of its body, add:

```tsx
setFilteredResults(prev => {
  if (!(label in prev)) return prev;
  const next = { ...prev };
  delete next[label];
  return next;
});
```

`label` is the function's parameter. If the existing parameter is named differently, use that name.

- [ ] **Step 6: Verify end-to-end**

Dev server:
- Start fresh, no analyzed tiles → Processing tab shows "Analyze tiles in the Depth tab first".
- Analyze a few tiles in the Depth tab → Processing tab enables, preview works.
- Click Export Stitched XYZ in DepthLab (old raw path) → still works identically.
- Toggle 180° in DepthLab, go back to Processing → the Export Filtered Stitched XYZ will use the same rotation flag.
- Apply filters, export → file downloads.
- Re-analyze a tile in DepthLab → that tile is removed from `filteredResults` (see the Processing tab's "Filtered tiles in memory" counter drop).

- [ ] **Step 7: Commit**

```
git add App.tsx components/DepthLab.tsx
git commit -m "feat: wire Processing tab into App and lift rotateFrames from DepthLab"
```

---

## Task 15: End-to-end manual verification (Gwyddion)

**Files:** None modified. User-facing checkout.

- [ ] **Step 1: Analyze a multi-tile scan**

Open the app, run a small grid (2×2 or 3×3) scan, analyze all tiles in the Depth tab.

- [ ] **Step 2: Verify non-regression on raw export**

In Depth tab, click **Export Stitched XYZ** → download the file. Open in Gwyddion using the XYZ importer (Lateral units `µm`, Value units `µm`, Create image directly from regular points ✅). Note the heightmap — it should match what you verified in the earlier stitched-XYZ manual verification.

- [ ] **Step 3: Apply default filters and export**

Switch to the Processing tab. Leave all three filters enabled at their defaults. Click **Apply to all tiles** → wait for progress bar to fill. Click **Export Filtered Stitched XYZ**.

- [ ] **Step 4: Compare filtered output in Gwyddion**

Open the filtered file with the same Gwyddion importer settings. Mask via Data Process → Mask → Mask by Threshold with upper bound `0` (same as before).

Expected:
- Shape of the sample is preserved.
- Spike noise (vertical flyaways in any profile plot) is visibly reduced relative to the raw file.
- No new holes or artifacts in covered regions.
- Sample a 1D profile through the same cross-section as the earlier noisy graph: the previous ~2 mm Y-axis spikes should now land within a tighter envelope around the underlying shape.

- [ ] **Step 5: Verify cancel + discard**

Back in the app:
- Click **Discard Filtered** → Filtered tiles in memory drops to 0 / N, Export Filtered Stitched XYZ disables.
- Click **Apply to all tiles** again → partway through, click **Cancel**. The progress bar should stop. The "in memory" counter should show however many tiles finished before cancel. Export remains available for the partial set.

- [ ] **Step 6: Verify stale-tile eviction**

In DepthLab, clear one tile (trash icon) and re-analyze it. Return to Processing — the "in memory" counter should decrement by one. Re-apply to refresh that tile into the filtered set.

---

## Self-Review Checklist

Walked the plan against the spec:

**Spec coverage:**
- User flow (spec §User flow, 1-5) → Tasks 9-14 cover preview, controls, apply bar, export, tab wiring.
- Architecture new files → Tasks 1-9 create each file.
- Untouched files → verified none of the tasks modify `depthStitcher.ts`, `StitchingView.tsx`, `server.ts`, `types.ts`, or Python.
- Filter specs (Hampel / Median / Bilateral math + defaults) → Tasks 2, 3, 4, 1 (defaults).
- Sentinel + NaN handling → `isValid` helper in Task 1; all three filters use it in Tasks 2-4.
- Mirror-padding at borders → Tasks 2-4 include the mirror formula.
- Worker pool + transferable buffers → Tasks 7-8.
- Progress + cancel semantics → Task 12 wiring.
- Stale tile eviction → Task 14 Step 5.
- Filename `Depth_Filtered_Stitched_<timestamp>.xyz` → Task 13.
- `filteredResults` uses existing `DepthResult` shape → Task 12 onResult callback reconstructs `DepthResult` with filtered depthValues + recomputed minZ/maxZ in mm.
- Manual verification → Task 15.

**Placeholder scan:** None found. Every code step has complete code; every verification step has exact commands and expected output.

**Type consistency:** `FilterConfig` signature stays identical from Task 1 through Task 12. `FilterJob` / `FilterResult` / `FilterProgress` from Task 8 are consumed unchanged in Task 12. `DepthResult` shape is imported from existing `types.ts` throughout.

**Type consistency caveat:** Task 14 Step 4 lifts `rotateFrames` out of DepthLab into App. This is a small refactor of existing code, explicit in the task and required so both tabs see the same flag. No other existing code is touched.
