# Data Processing Tab — Design

## Goal

Add a new top-level tab ("Processing") that applies optional noise-reduction filters to per-tile depth data and exports a filtered stitched `.xyz` file. Filtering is **non-destructive**: raw `DepthResult.depthValues` are never mutated, the existing `services/depthStitcher.ts` and `components/DepthLab.tsx` export flows remain untouched, and a parallel `filteredResults` state drives a dedicated filtered export.

## Non-goals

- Changing `stitchDepthToXYZ` or any DepthLab behavior.
- Per-tile filtered exports (CSV / XYZ / heatmap JPG). Only the stitched filtered XYZ ships in v1.
- Server-side Python filtering. All compute is browser-local.
- Automatic re-filtering when tiles change upstream. User re-clicks Apply to refresh.

## User flow

1. User analyzes tiles in DepthLab as usual. The Processing tab shows `<finished> / <total>` in its badge; button is disabled until at least one tile has finished.
2. User clicks **Processing**.
3. **Left column — preview:**
   - Dropdown selects a preview tile (default: first finished).
   - Tile depth is downsampled to max 1024 px per dimension for instant filter feedback.
   - Two side-by-side canvases render **Raw** and **Filtered** heatmaps using the same jet-style colormap as the existing Python output.
   - A 1D profile plot below the canvases: user clicks a row in either canvas → both raw and filtered profiles are overlaid across that row.
4. **Right column — controls:**
   - Three collapsible filter panels, each with an on/off toggle and sliders. All three enabled by default.
   - Pipeline order is fixed and non-configurable: **Hampel → Median → Bilateral**.
   - "Reset to defaults" button restores factory settings.
5. **Bottom bar:**
   - **"Apply to all tiles"** button. Spins up the Web Worker pool, processes every finished tile. Shows progress bar (`N / total`) and a Cancel button.
   - **"Discard Filtered"** button — clears `filteredResults`, returns to raw-only state.
   - **"Export Filtered Stitched XYZ"** button. Disabled until at least one successful apply. Reuses `stitchDepthToXYZ` against `filteredResults`. Filename: `Depth_Filtered_Stitched_<timestamp>.xyz`.

## Architecture

### New files

- **`services/depthFilters.ts`** — pure filter functions, no DOM/React, no imports from React code. Each handles the `-1` sentinel and `NaN` by: (a) skipping as neighborhood samples, (b) passing through unchanged when the center pixel is `-1` or NaN. Exports:

  ```ts
  export type FilterConfig = {
    hampel:    { enabled: boolean; kernel: 3 | 5 | 7; threshold: number };
    median:    { enabled: boolean; kernel: 3 | 5 | 7 | 9 };
    bilateral: { enabled: boolean; spatialSigma: number; rangeSigma: number };
  };

  export const DEFAULT_FILTER_CONFIG: FilterConfig;

  export function medianFilter(src: Float32Array, w: number, h: number, kernel: number): Float32Array;
  export function hampelFilter(src: Float32Array, w: number, h: number, kernel: number, threshold: number): Float32Array;
  export function bilateralFilter(src: Float32Array, w: number, h: number, spatialSigma: number, rangeSigma: number): Float32Array;
  export function applyPipeline(src: Float32Array, w: number, h: number, config: FilterConfig): Float32Array;
  ```

- **`services/depthHeatmapCanvas.ts`** — client-side colormap renderer.

  ```ts
  export function renderDepthToCanvas(
    depthValues: Float32Array, w: number, h: number,
    min: number, max: number,
    canvas: HTMLCanvasElement,
  ): void;

  export function downsample(
    src: Float32Array, w: number, h: number, maxDim: number,
  ): { data: Float32Array; w: number; h: number };
  ```

  Jet colormap: `-1` / NaN → transparent; values within `[min, max]` → RGB via a 256-entry LUT. Downsample uses nearest-neighbor (fast; acceptable for preview).

- **`services/depthFilterWorker.ts`** — Web Worker entry. Receives `{ tile: Float32Array (transferred), w, h, config }`. Imports `depthFilters.ts`. Runs `applyPipeline`. Posts back `{ filtered: Float32Array (transferred) }`. Uses transferable `ArrayBuffer`s — no copy on the boundary.

  Built as a Vite-style module worker: `new Worker(new URL('./depthFilterWorker.ts', import.meta.url), { type: 'module' })`.

- **`services/depthFilterPool.ts`** — worker pool manager.

  ```ts
  export type FilterJob = { label: string; src: Float32Array; w: number; h: number };
  export type FilterProgress = { done: number; total: number; lastLabel: string };

  export class DepthFilterPool {
    constructor(workerCount?: number);   // defaults to min(hardwareConcurrency - 1, 4)
    run(
      jobs: FilterJob[],
      config: FilterConfig,
      onProgress: (p: FilterProgress) => void,
    ): Promise<Map<string, Float32Array>>;
    cancel(): void;                       // terminates all workers; already-finished results are preserved via onProgress callbacks
  }
  ```

  Jobs are dispatched round-robin. On failure, the pool logs the error, marks that tile as failed (does not appear in the result map), and continues with others.

- **`components/DataProcessing.tsx`** — the tab. Holds local state for `previewLabel`, `filterConfig`, `applyInProgress`, `applyProgress`. Accepts `filteredResults` and `setFilteredResults` as props. Renders preview canvases via `depthHeatmapCanvas` + full-size filter via `depthFilters` (preview is main-thread, operating only on downsampled data).

### Modified files

- **`App.tsx`:**
  - Extend tab union: `... | 'processing'`.
  - Add tab button in the tab bar (icon: `Sliders` from lucide-react; label: "Process").
  - Add state: `const [filteredResults, setFilteredResults] = useState<Record<string, DepthResult>>({});`.
  - Render `<DataProcessing results={depthResults} filteredResults={filteredResults} setFilteredResults={setFilteredResults} grid={grid} settings={settings} />` under `activeTab === 'processing'`.
  - On tile re-analysis (existing `handleTriggerDepth` flow), evict the matching label from `filteredResults` so stale filtered data is dropped.

### Untouched files

- `services/depthStitcher.ts`
- `components/DepthLab.tsx`
- `components/StitchingView.tsx`
- `server.ts`, all Python (`services/*.py`)

## State shape

`filteredResults` uses the existing `DepthResult` type verbatim. For each filtered tile:

```ts
{
  label,
  dataUrl: "",      // not rendered by DataProcessing; heatmap is canvas-drawn per frame
  depthValues: Float32Array,    // filtered
  width, height,
  isProcessing: false,
  minZ, maxZ,                   // recomputed from filtered depthValues (ignoring -1 sentinel)
  method: results[label].method + "+filtered",
}
```

`stitchDepthToXYZ` accepts this as-is — signature unchanged.

## Filter specifications

All three skip `-1` (uncovered sentinel) and `NaN` as neighborhood samples and pass them through unchanged when they are the center pixel.

### Hampel (spike kill) — first in pipeline

Per pixel `(x, y)`:

1. Collect valid samples in a `K × K` neighborhood (mirror-padded at borders).
2. `m = median(samples)`.
3. `mad = median(|samples - m|)`.
4. `sigma = 1.4826 * mad` (MAD-based σ estimator for Gaussian noise).
5. If `|p - m| > threshold * sigma`, output `m`; else output `p`.

Controls: kernel 3 / 5 / 7 (default 5), threshold 1.0 – 5.0 (default 3.0).

### Median (general smoothing) — second in pipeline

Per pixel: output = median of valid samples in `K × K` neighborhood. Mirror-padded.

Controls: kernel 3 / 5 / 7 / 9 (default 3).

Implementation: histogram-based sliding window for `K ≥ 5` (O(K) per pixel, not O(K² log K²)). For K = 3, direct partial sort.

### Bilateral (edge-preserving smooth) — third in pipeline

Per pixel `p` at `(x, y)`:

```
output = Σ_i (w_s * w_r * p_i) / Σ_i (w_s * w_r)
  w_s = exp(-((dx² + dy²) / (2 σ_s²)))
  w_r = exp(-((p_i - p)² / (2 σ_r²)))
```

Neighborhood radius `R = round(3 * σ_s)`, capped at 7.

Controls: spatial σ 0.5 – 3.0 (default 1.5), range σ 5 – 100 µm (default 20).

### Default pipeline config

```ts
{
  hampel:    { enabled: true, kernel: 5, threshold: 3.0 },
  median:    { enabled: true, kernel: 3 },
  bilateral: { enabled: true, spatialSigma: 1.5, rangeSigma: 20 },
}
```

## Data flow

```
User clicks "Apply to all tiles"
  → DataProcessing gathers finished tiles from `results`
  → DepthFilterPool.run(jobs, config, onProgress)
      → each worker: applyPipeline(src, w, h, config) → post back Float32Array
      → pool updates setFilteredResults incrementally as each tile completes
        (so a mid-apply Cancel still leaves finished tiles usable)
  → progress bar advances via onProgress
  → Apply button re-enables; Export Filtered Stitched XYZ becomes clickable

User clicks "Export Filtered Stitched XYZ"
  → stitchDepthToXYZ(filteredResults, grid, settings, rotate180) — same pure function
  → chunked Blob download, filename `Depth_Filtered_Stitched_<timestamp>.xyz`
```

## Edge cases

- **Sentinel `-1` cells:** skipped as neighborhood samples (never drag values toward -1); passed through as centers.
- **NaN in raw depth:** treated identically to `-1`.
- **Near-edge pixels:** mirror-padded neighborhoods.
- **Preview tile missing / cleared:** dropdown auto-picks the first finished tile; if zero finished, canvases show a placeholder message.
- **Apply while DepthLab is still analyzing:** only currently-finished tiles are processed. Re-click Apply to pick up late arrivals.
- **Stale filtered tiles** (user re-analyzes a tile in DepthLab after filtering): the matching key is evicted from `filteredResults` in `handleTriggerDepth`. A warning banner in the Processing tab says "Some tiles are stale — re-apply to update." Export button stays enabled; stale/missing tiles fall back to `-1` in the filtered stitched output.
- **Worker crash / filter throws:** pool catches, logs, continues. Final report: "24 / 25 succeeded, 1 failed (A3)". Failed tiles are absent from `filteredResults`.
- **Cancel mid-apply:** `worker.terminate()` on all workers. Already-finished tiles remain in `filteredResults`. In-flight tile is abandoned.
- **Memory pressure at 5×5 × 4K:** `filteredResults` roughly doubles depth memory (≈ 830 MB at 5×5 × 4K). A static warning sits next to the Apply button. Not mitigated in v1. The "Discard Filtered" button frees it.
- **Tile dimension mismatch:** skipped with `console.warn`, same rule as the stitcher.

## Performance targets

At 5×5 × 4K (25 tiles, 8.3 M pixels each) with 4 parallel workers, all three filters enabled:

- Hampel 5×5: ~0.8 s/tile × 25 / 4 ≈ **~5 s**
- Median 3×3: ~0.3 s/tile × 25 / 4 ≈ **~2 s**
- Bilateral 5×5 radius: ~1.7 s/tile × 25 / 4 ≈ **~11 s**
- **Total ≈ 18–20 s with UI responsive the whole time.**

Preview on a downsampled 1024×576 tile: < 50 ms per filter pass — snappy enough for live sliders without debouncing.

## Verification

Manual, no automated tests (matches project precedent):

### Filter correctness

1. **Synthetic flat + spike:** 64×64 constant 500 µm with one cell at 50000 µm. Hampel defaults → spike replaced with 500, all others untouched.
2. **Synthetic checkerboard:** 64×64 alternating 100 / 900. Median 3×3 → flattens to ~500.
3. **Synthetic ramp:** 0 → 1000 linear gradient. All three defaults → ramp stays clean, ends unchanged, slope preserved.
4. **Sentinel passthrough:** inject `-1` cells. Output preserves exact `-1` positions; neighbors are not dragged toward negative values.

### Preview parity

Pick a finished tile. Turn all three filters off in the Processing tab. Raw and Filtered canvases should be visually identical to each other and match the DepthLab heatmap (modulo downsample and colormap fidelity).

### Worker pool

- 5×5 grid: Apply → progress bar advances, UI stays interactive (scroll, switch tabs).
- Cancel mid-apply: remaining tiles abort, finished ones stay in `filteredResults`.

### End-to-end

- Apply defaults to the triangle-surface scan.
- Export Filtered Stitched XYZ → open in Gwyddion (same lateral/value units, same mask-by-threshold workflow for `-1`).
- Pull a 1D profile through the same cross-section as the earlier noisy graph — spikes gone, triangle shape preserved.
- Diff test: export raw stitched XYZ + filtered stitched XYZ. Uncovered cells (`-1`) should match. Covered cells should differ, concentrated at spike locations.

### Non-regression

Existing DepthLab buttons (Analyze All, Export All Data, Stitch Depth Map, Export Stitched XYZ, 180° toggle) behave identically. Processing tab is purely additive.
