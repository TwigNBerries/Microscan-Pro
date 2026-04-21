# Stitched XYZ Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Export Stitched XYZ" button to DepthLab that resamples every tile's `depthValues` onto one global grid with feather-blended overlap zones and writes a single `.xyz` file in the same tab-separated `X_um\tY_um\tZ_um` format as the existing per-tile export.

**Architecture:** A new pure-function module `services/depthStitcher.ts` builds a global `(globalW × globalH)` raster from per-tile depth arrays using bilinear feather weighting across overlap regions, then streams the result to a `Blob` in chunks. `DepthLab.tsx` gains a 180° rotation toggle, a new export button, and a click handler that invokes the stitcher and triggers a download. No changes to `StitchingView.tsx` or the Python depth processor.

**Tech Stack:** React 19, TypeScript, `Float32Array`, `Blob`, TailwindCSS, Lucide icons. No new dependencies. No test framework (project has none — verification is manual, matching the precedent set by [docs/superpowers/plans/2026-04-16-exposure-controls.md](docs/superpowers/plans/2026-04-16-exposure-controls.md)).

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| **Create** | `services/depthStitcher.ts` | Pure function `stitchDepthToXYZ` + helpers (`featherAlpha`, `buildGridDims`, `accumulateTile`, `serializeToBlob`) |
| **Modify** | `components/DepthLab.tsx` | Add `rotateFrames` + `isStitchingXYZ` state, 180° toggle button, Export Stitched XYZ button, and the click handler that invokes the stitcher |

---

## Task 1: `depthStitcher.ts` scaffold + feather-alpha helper

**Files:**
- Create: `services/depthStitcher.ts`

- [ ] **Step 1: Create the file with the feather helper**

Create `services/depthStitcher.ts`:

```ts
/**
 * Stitched XYZ Exporter
 *
 * Resamples every tile's depthValues onto one global raster grid with
 * bilinear feather weighting across overlap regions, then serializes the
 * grid to a tab-separated XYZ Blob.
 */

import { DepthResult, GridDimensions, ScanSettings } from '../types';
import { getAlphabetLabel, getInterpolatedData } from './gcodeService';

/**
 * Bilinear feather weight for a tile-local pixel. Returns 1.0 in the tile's
 * non-overlap core; ramps linearly to 0.0 across an overlap edge that has a
 * neighbor tile; outer mosaic edges get full weight. The product of X and Y
 * 1D ramps gives a smooth 2D corner blend that matches single-pass feather
 * image-stitching practice.
 */
export function featherAlpha(
  px: number, py: number,
  tileW: number, tileH: number,
  overlapPxX: number, overlapPxY: number,
  hasLeft: boolean, hasRight: boolean,
  hasTop: boolean, hasBottom: boolean,
): number {
  let wx = 1;
  if (hasLeft && px < overlapPxX) wx = overlapPxX > 0 ? px / overlapPxX : 1;
  else if (hasRight && px >= tileW - overlapPxX) wx = overlapPxX > 0 ? (tileW - 1 - px) / overlapPxX : 1;

  let wy = 1;
  if (hasTop && py < overlapPxY) wy = overlapPxY > 0 ? py / overlapPxY : 1;
  else if (hasBottom && py >= tileH - overlapPxY) wy = overlapPxY > 0 ? (tileH - 1 - py) / overlapPxY : 1;

  const w = wx * wy;
  return w > 0 ? w : 0;
}
```

- [ ] **Step 2: Type-check**

Run: `npm run lint`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add services/depthStitcher.ts
git commit -m "feat: scaffold depthStitcher with feather-alpha helper"
```

---

## Task 2: Grid dimensions + tile accumulation

**Files:**
- Modify: `services/depthStitcher.ts`

- [ ] **Step 1: Add `buildGridDims` and `accumulateTile`**

Append to `services/depthStitcher.ts` below `featherAlpha`:

```ts
interface GlobalGridDims {
  globalW: number;
  globalH: number;
  overlapPxX: number;
  overlapPxY: number;
}

export function buildGridDims(
  grid: GridDimensions,
  settings: ScanSettings,
  tileW: number,
  tileH: number,
  pixelSizeUm: number,
): GlobalGridDims {
  const totalWidthMm = grid.fovX + (grid.cols - 1) * grid.stepX;
  const totalHeightMm = grid.fovY + (grid.rows - 1) * grid.stepY;
  const globalW = Math.round((totalWidthMm * 1000) / pixelSizeUm);
  const globalH = Math.round((totalHeightMm * 1000) / pixelSizeUm);
  const overlapPxX = Math.round((tileW * settings.overlapPercent) / 100);
  const overlapPxY = Math.round((tileH * settings.overlapPercent) / 100);
  return { globalW, globalH, overlapPxX, overlapPxY };
}

export function accumulateTile(
  result: DepthResult,
  row: number, col: number,
  grid: GridDimensions,
  pixelSizeUm: number,
  overlapPxX: number, overlapPxY: number,
  rotate180: boolean,
  globalW: number, globalH: number,
  zAccum: Float32Array,
  wAccum: Float32Array,
): void {
  const { depthValues, width: tileW, height: tileH } = result;
  const tileX0 = Math.round((col * grid.stepX * 1000) / pixelSizeUm);
  const tileY0 = Math.round((row * grid.stepY * 1000) / pixelSizeUm);
  const hasLeft = col > 0;
  const hasRight = col < grid.cols - 1;
  const hasTop = row > 0;
  const hasBottom = row < grid.rows - 1;

  for (let py = 0; py < tileH; py++) {
    const gy = tileY0 + py;
    if (gy < 0 || gy >= globalH) continue;
    for (let px = 0; px < tileW; px++) {
      const gx = tileX0 + px;
      if (gx < 0 || gx >= globalW) continue;
      const srcPx = rotate180 ? tileW - 1 - px : px;
      const srcPy = rotate180 ? tileH - 1 - py : py;
      const z = depthValues[srcPy * tileW + srcPx];
      if (!Number.isFinite(z)) continue;
      const w = featherAlpha(
        px, py, tileW, tileH,
        overlapPxX, overlapPxY,
        hasLeft, hasRight, hasTop, hasBottom,
      );
      if (w <= 0) continue;
      const gi = gy * globalW + gx;
      zAccum[gi] += z * w;
      wAccum[gi] += w;
    }
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add services/depthStitcher.ts
git commit -m "feat: add grid sizing and tile accumulation to depthStitcher"
```

---

## Task 3: Chunked XYZ serialization

**Files:**
- Modify: `services/depthStitcher.ts`

- [ ] **Step 1: Add `serializeToBlob`**

Append to `services/depthStitcher.ts`:

```ts
/**
 * Serialize the accumulated grid to a tab-separated XYZ Blob. Builds the
 * output in 50k-row chunks to avoid a single giant string allocation —
 * matches the chunking pattern used by the per-tile handleDownloadXYZ.
 */
export function serializeToBlob(
  zAccum: Float32Array,
  wAccum: Float32Array,
  globalW: number, globalH: number,
  pixelSizeUm: number,
): Blob {
  const parts: string[] = ["X_um\tY_um\tZ_um\n"];
  let chunk: string[] = [];
  for (let gy = 0; gy < globalH; gy++) {
    const yStr = (gy * pixelSizeUm).toFixed(4);
    for (let gx = 0; gx < globalW; gx++) {
      const xStr = (gx * pixelSizeUm).toFixed(4);
      const gi = gy * globalW + gx;
      const w = wAccum[gi];
      const zStr = w > 0 ? (zAccum[gi] / w).toFixed(4) : "NaN";
      chunk.push(`${xStr}\t${yStr}\t${zStr}\n`);
      if (chunk.length > 50000) {
        parts.push(chunk.join(""));
        chunk = [];
      }
    }
  }
  if (chunk.length > 0) parts.push(chunk.join(""));
  return new Blob(parts, { type: "text/plain" });
}
```

- [ ] **Step 2: Type-check**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add services/depthStitcher.ts
git commit -m "feat: add chunked XYZ Blob serializer"
```

---

## Task 4: Top-level `stitchDepthToXYZ`

**Files:**
- Modify: `services/depthStitcher.ts`

- [ ] **Step 1: Add the exported top-level function**

Append to `services/depthStitcher.ts`:

```ts
/**
 * Stitch every finished tile's depthValues into a single tab-separated XYZ
 * Blob. Tiles missing from `results`, still processing, or with dimensions
 * mismatched against the first tile are skipped — their regions become NaN
 * rows in the output so the grid stays rectangular.
 *
 * Z values are written verbatim from DepthResult.depthValues (already in
 * microns after the conversion in depthService.ts).
 */
export function stitchDepthToXYZ(
  results: Record<string, DepthResult>,
  grid: GridDimensions,
  settings: ScanSettings,
  rotate180: boolean,
): Blob {
  const finished = (Object.values(results) as DepthResult[]).filter(
    r => r.depthValues.length > 0 && !r.isProcessing,
  );
  if (finished.length === 0) {
    throw new Error("No finished depth results to stitch.");
  }

  const tileW = finished[0].width;
  const tileH = finished[0].height;
  const specs = getInterpolatedData(settings.magnification);
  const pixelSizeUm = (specs.fovX * 1000) / tileW;

  const { globalW, globalH, overlapPxX, overlapPxY } =
    buildGridDims(grid, settings, tileW, tileH, pixelSizeUm);

  const zAccum = new Float32Array(globalW * globalH);
  const wAccum = new Float32Array(globalW * globalH);

  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const label = `${getAlphabetLabel(row)}${col + 1}`;
      const result = results[label];
      if (!result || result.depthValues.length === 0 || result.isProcessing) continue;
      if (result.width !== tileW || result.height !== tileH) {
        console.warn(
          `[stitchDepthToXYZ] Tile ${label} has mismatched dimensions ` +
          `(${result.width}x${result.height} vs ${tileW}x${tileH}); skipping.`,
        );
        continue;
      }
      accumulateTile(
        result, row, col, grid, pixelSizeUm,
        overlapPxX, overlapPxY, rotate180,
        globalW, globalH, zAccum, wAccum,
      );
    }
  }

  return serializeToBlob(zAccum, wAccum, globalW, globalH, pixelSizeUm);
}
```

- [ ] **Step 2: Type-check**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add services/depthStitcher.ts
git commit -m "feat: add top-level stitchDepthToXYZ"
```

---

## Task 5: DepthLab state + buttons

**Files:**
- Modify: `components/DepthLab.tsx`

- [ ] **Step 1: Add the stitcher import**

In `components/DepthLab.tsx`, find the existing imports block at the top and add:

```tsx
import { stitchDepthToXYZ } from '../services/depthStitcher';
```

Also extend the `lucide-react` import to include `RotateCcw` and `Loader2`. The existing line reads:

```tsx
import { Activity, RefreshCw, Map, CheckCircle, Clock, FolderDown, Download, Thermometer, FileText, Play, ArrowLeft, Combine, Trash2, FileOutput } from 'lucide-react';
```

Replace it with:

```tsx
import { Activity, RefreshCw, Map, CheckCircle, Clock, FolderDown, Download, Thermometer, FileText, Play, ArrowLeft, Combine, Trash2, FileOutput, RotateCcw, Loader2 } from 'lucide-react';
```

- [ ] **Step 2: Add state for rotation and stitching-in-progress**

Inside the `DepthLab` component, find the existing `const [selectedMethod, setSelectedMethod] = useState<DepthMethod>('laplacian');` line and add these two lines directly below it:

```tsx
  const [rotateFrames, setRotateFrames] = useState(false);
  const [isStitchingXYZ, setIsStitchingXYZ] = useState(false);
```

- [ ] **Step 3: Add a `finishedCount` memo**

Below the new state lines, add:

```tsx
  const finishedCount = (Object.values(results) as DepthResult[]).filter(r => r.dataUrl && !r.isProcessing).length;
```

- [ ] **Step 4: Add the export handler (empty for now — wired in Task 6)**

Directly above the existing `const handleDownloadAllDepths = async () => {` line, add a stub:

```tsx
  const handleDownloadStitchedXYZ = async () => {
    // Implemented in Task 6
  };
```

- [ ] **Step 5: Add the 180° toggle and Export Stitched XYZ buttons to the action row**

Find the existing action-button cluster (around line 178 of the file) — the div that contains `Analyze All`, `Stitch Depth Map`, `Export All Data`. The existing block looks like:

```tsx
          <div className="flex gap-2 mt-auto">
            <button 
              onClick={handleAnalyzeAll}
              ...
            >
              <Play className="w-4 h-4" /> Analyze All
            </button>
            <button 
              onClick={() => setShowStitching(true)}
              ...
            >
              <Combine className="w-4 h-4" /> Stitch Depth Map
            </button>
            <button 
              onClick={handleDownloadAllDepths}
              ...
            >
              <FolderDown className="w-4 h-4" /> Export All Data
            </button>
          </div>
```

Insert the two new buttons at the end of that flex row, immediately after the `Export All Data` button's closing `</button>`:

```tsx
            <button
              onClick={() => setRotateFrames(r => !r)}
              title="Toggle 180° frame rotation correction for stitched XYZ export"
              className={`px-4 py-3 rounded-2xl font-black text-xs border flex items-center gap-2 transition-all ${
                rotateFrames
                  ? 'bg-violet-500 text-white border-violet-400 shadow-lg shadow-violet-500/30'
                  : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
              }`}
            >
              <RotateCcw className="w-4 h-4" />
              180° {rotateFrames ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={handleDownloadStitchedXYZ}
              disabled={isStitchingXYZ || finishedCount === 0}
              title="Stitch all tile depth data into one XYZ file"
              className="px-6 py-3 bg-amber-500 text-slate-900 rounded-2xl font-black text-xs shadow-xl flex items-center gap-2 hover:bg-amber-400 transition-all disabled:opacity-30"
            >
              {isStitchingXYZ ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileOutput className="w-4 h-4" />}
              Export Stitched XYZ
            </button>
```

- [ ] **Step 6: Type-check**

Run: `npm run lint`
Expected: PASS. (The handler is still a stub; it compiles because its body is empty.)

- [ ] **Step 7: Commit**

```bash
git add components/DepthLab.tsx
git commit -m "feat: add 180 toggle and Export Stitched XYZ button to DepthLab"
```

---

## Task 6: Wire the export handler

**Files:**
- Modify: `components/DepthLab.tsx`

- [ ] **Step 1: Replace the stub handler with the real implementation**

Find the stub added in Task 5 Step 4:

```tsx
  const handleDownloadStitchedXYZ = async () => {
    // Implemented in Task 6
  };
```

Replace it with:

```tsx
  const handleDownloadStitchedXYZ = async () => {
    if (isStitchingXYZ) return;
    setIsStitchingXYZ(true);
    try {
      // Yield one frame so the spinner icon paints before the synchronous stitch blocks the main thread
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const blob = stitchDepthToXYZ(results, grid, settings, rotateFrames);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Depth_Stitched_${Date.now()}.xyz`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (err) {
      console.error("Stitched XYZ export failed:", err);
    } finally {
      setIsStitchingXYZ(false);
    }
  };
```

- [ ] **Step 2: Type-check**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add components/DepthLab.tsx
git commit -m "feat: wire Export Stitched XYZ handler in DepthLab"
```

---

## Task 7: Manual verification

**Files:** none modified — exercise the feature end-to-end.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: Server starts and serves the app. Browse to the printed URL.

- [ ] **Step 2: Single-tile parity test**

Configure a 1×1 grid, capture a Z-stack, run Depth analysis on the single tile. In DepthLab:
1. Click the tile's per-tile XYZ button (amber FileOutput icon) → saves `Depth_Data_A1.xyz`.
2. Click **Export Stitched XYZ** (180° OFF) → saves `Depth_Stitched_<ts>.xyz`.

Open both files in a text editor or run `diff` (ignoring filenames). Expected: the two files have the same row count and the same `Z_um` values in the same order. X/Y columns match bit-for-bit.

- [ ] **Step 3: Multi-tile seam test**

Configure a 2×2 grid, capture Z-stacks, run **Analyze All**. Click **Export Stitched XYZ** (180° OFF). Open the resulting file in Gwyddion as "XYZ data":
- Confirm the heightmap is 2× the dimensions of a single tile in both X and Y.
- Confirm tile seams are visually continuous (no sharp step along row/column boundaries between tiles).
- Confirm the physical extent in mm matches `grid.fovX + grid.stepX` by `grid.fovY + grid.stepY`.

- [ ] **Step 4: 180° rotation test**

With the same 2×2 data loaded, toggle **180° ON** and click **Export Stitched XYZ** again. Open the new file in Gwyddion.

Expected: the heightmap appears flipped 180° (both X and Y mirrored) versus Step 3. Seam continuity is preserved (the flip happens inside each tile before blending, not by flipping the grid).

- [ ] **Step 5: NaN handling test**

With the 2×2 grid, clear the depth result for one tile (e.g., A1) using the trash icon, leaving A2/B1/B2 finished. Click **Export Stitched XYZ**.

Expected:
- Export still runs (does not throw — only requires ≥1 finished tile).
- File contains `NaN` rows in the top-left quadrant (the missing A1 region) while the other three quadrants have valid Z values.
- Gwyddion opens the file and shows missing-data holes in the cleared quadrant.

- [ ] **Step 6: Button-state test**

Clear all depth results. Expected: **Export Stitched XYZ** is disabled (visibly dimmed) because `finishedCount === 0`. Re-run Analyze on one tile. Expected: the button re-enables once at least one tile finishes.

- [ ] **Step 7: Final commit (only if fixes were needed)**

If any manual test surfaced a bug and you made a fix, commit it with a descriptive message. If all tests passed without changes, skip this step.

```bash
git add <fixed-files>
git commit -m "fix: <specific bug description>"
```

---

## Self-Review Checklist (post-write)

- Every spec section is covered: output format (Task 3), algorithm (Tasks 1-4), UI surface (Tasks 5-6), edge cases (Task 4 handles missing/mismatched tiles; Task 2 handles NaN depthValues; Task 5 handles disabled-button state; verified in Task 7), orientation via 180° toggle (Tasks 2 + 5).
- Function names are consistent across tasks: `featherAlpha`, `buildGridDims`, `accumulateTile`, `serializeToBlob`, `stitchDepthToXYZ` appear with identical signatures where referenced.
- No placeholders or "similar to Task N" references — all code shown in full.
