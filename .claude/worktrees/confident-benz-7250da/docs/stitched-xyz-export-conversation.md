# Stitched XYZ Export — Conversation Log

**Date:** 2026-04-17
**Branch:** `claude/confident-benz-7250da`
**Feature:** Export all tile depth data as a single stitched `.xyz` file

---

## 1. Original Request

The user asked for a way to stitch per-tile XYZ depth data into one large exportable file, analogous to how the heatmap images are stitched.

Requirements that emerged during discussion:

- Output must use the same tab-separated `X_um\tY_um\tZ_um` XYZ format as the existing per-tile `Depth_Data_<label>.xyz` export
- Orientation must be preserved
- Must support an optional **180° rotation** toggle (matching the image-stitching flow)
- Overlap regions must be **blended**, not duplicated

Attached sample: `C:\Users\jonah\Downloads\Depth_Data_A1 (1).xyz` — the per-tile reference file to match byte-for-byte.

---

## 2. Brainstormed Approaches

Two approaches were offered for analysis:

### Approach 1 — Concatenate per-tile XYZ with offset
Append each tile's rows into one file, offsetting X/Y by its physical grid position. Simple, but produces **duplicate points** in overlap regions and does not blend — heightmap seams would look "doubled up" in Gwyddion.

### Approach 2 — Resample onto one global raster grid (selected)
Build a single global pixel grid sized to the entire mosaic, then for every tile pixel add its Z into `zAccum[global_index]` weighted by a bilinear feather, and accumulate weight into `wAccum`. At the end divide to get a blended Z per cell. Emit a dense rectangular raster.

**Why approach 2 won:** no duplicate points, seamless blending, Gwyddion-ready rectangular grid. Matches the semantics of the existing RGB `blendHorizontal`/`blendVertical` in `StitchingView.tsx`, applied to a scalar Z channel.

A third "extract from stitched image" approach was considered but dismissed — lossy round-trip through JPEG heatmap colors.

### NaN handling (chose option C)
For cells where no tile contributes a valid Z (missing tile, all-NaN region), emit the literal text `NaN` in the Z column. The X and Y columns are still emitted so the grid stays rectangular.

---

## 3. Design Spec

Written to `docs/superpowers/specs/2026-04-17-stitched-xyz-export-design.md` and committed (`0e416eb`, unit fix `80a73a5`).

Highlights:

- **New module** `services/depthStitcher.ts` exporting a pure function:
  ```ts
  stitchDepthToXYZ(
    results: Record<string, DepthResult>,
    grid: GridDimensions,
    settings: ScanSettings,
    rotate180: boolean
  ): Blob
  ```
- **UI in `components/DepthLab.tsx`:** a new amber "Export Stitched XYZ" button + a 180° toggle
- **Algorithm:**
  1. Build global grid dims from `grid.fovX/fovY`, `grid.stepX/stepY`, and `pixelSizeUm`
  2. For each tile: accumulate `z * weight` into `zAccum`, `weight` into `wAccum` with a 1D bilinear feather on each edge that has a neighbor
  3. Finalize `zGrid[i] = wAccum[i] > 0 ? zAccum[i] / wAccum[i] : NaN`
  4. Serialize as chunked Blob (50k rows per chunk), raster scan (Y outer, X inner)
- **Filename:** `Depth_Stitched_<timestamp>.xyz`
- **180° rotation** flips per-tile pixel lookup (`srcPx = tileW - 1 - px`), **not** grid placement — same semantics as `StitchingView.rotateFrames`
- **Unit correctness:** `DepthResult.depthValues` is already in microns (converted from mm at `services/depthService.ts:173`), so the stitched file writes values verbatim

---

## 4. Implementation Plan

Written to `docs/superpowers/plans/2026-04-17-stitched-xyz-export.md` and committed (`8970ded`).

Seven tasks, each with bite-sized TDD-style steps:

| # | Task |
|---|------|
| 1 | Scaffold `depthStitcher.ts` with `featherAlpha` helper |
| 2 | Add `buildGridDims` + `accumulateTile` |
| 3 | Add chunked `serializeToBlob` |
| 4 | Add top-level `stitchDepthToXYZ` |
| 5 | DepthLab UI — 180° toggle + Export button + state |
| 6 | Wire real `handleDownloadStitchedXYZ` handler |
| 7 | Manual verification in Gwyddion (user-facing) |

---

## 5. Execution (Subagent-Driven)

Each task was dispatched to a fresh implementer subagent, followed by two-stage review (spec compliance → code quality) before proceeding.

### Commits on branch
```
6a75952  feat: wire stitched XYZ export handler in DepthLab
3299af3  feat: add 180 toggle and Export Stitched XYZ button to DepthLab
b6e4102  feat: add top-level stitchDepthToXYZ
0b7b0b3  feat: add chunked XYZ Blob serializer
ea5e532  feat: add grid sizing and tile accumulation to depthStitcher
ae7f438  feat: scaffold depthStitcher with feather-alpha helper
8970ded  docs: add stitched-xyz-export implementation plan
80a73a5  docs: fix depthValues unit note in spec
0e416eb  docs: add stitched-xyz-export design spec
```

### Files touched
- **Created:** `services/depthStitcher.ts` (~190 lines)
- **Modified:** `components/DepthLab.tsx` — Lucide imports extended (`RotateCcw`, `Loader2`), `stitchDepthToXYZ` import, `rotateFrames`/`isStitchingXYZ` state, `finishedCount` memo, `handleDownloadStitchedXYZ` handler, 180° toggle button + amber Export button in the action row

### Handler body
```tsx
const handleDownloadStitchedXYZ = async () => {
  if (isStitchingXYZ) return;
  setIsStitchingXYZ(true);
  try {
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

The `await new Promise(setTimeout, 0)` yield lets React paint the spinner before the synchronous stitch blocks the main thread.

---

## 6. Final Code Review — Approved

End-to-end review across all commits. Math verified:

- **1×1 grid** → `globalW = tileW` → byte-identical to per-tile export
- **2×1 @ 0% overlap** → `globalW = 2*tileW`, no gap/double-count
- **2×1 @ 20% overlap** → `globalW = round(1.8*tileW)`, `overlapPx = round(0.2*tileW)`
- **Feather midline:** two tiles' 1D ramps sum to ≈1.0 at every shared pixel; zero-weight edge pixels always align with near-full-weight neighbors → no seam holes
- **180° rotation:** flips only per-tile source lookup, not placement → correct per-frame flip semantics
- **Chunked Blob** is byte-identical to an unchunked version (row-terminal `\n`, empty join separator)

### Non-blocking follow-ups flagged
1. Add a memory guard on `globalW * globalH` before `Float32Array` allocation (defensive — expected sizes are safe)
2. Surface stitch errors via toast/inline UI instead of only `console.error`
3. Document `overlapPxX <= 0` fallback in `featherAlpha`
4. Wrap `finishedCount` in `useMemo`

None are required for Task 7.

---

## 7. Task 7 — Manual Verification (user)

1. `npm run dev`, open the depth panel
2. Run a **1×1** scan → use existing "Export All Data" and new "Export Stitched XYZ"; diff should match (ignoring filename)
3. Run a **multi-tile** scan → open the stitched `.xyz` in Gwyddion as "XYZ data"; confirm orientation, physical dimensions, and seam continuity match the image mosaic
4. Toggle **180° ON**, re-export → confirm the heightmap flips in Gwyddion

---

## Key File Paths

- Spec: `docs/superpowers/specs/2026-04-17-stitched-xyz-export-design.md`
- Plan: `docs/superpowers/plans/2026-04-17-stitched-xyz-export.md`
- New module: `services/depthStitcher.ts`
- UI: `components/DepthLab.tsx`
- Reference per-tile export: `C:\Users\jonah\Downloads\Depth_Data_A1 (1).xyz`
- Sibling image stitcher (for rotation/blend reference): `components/StitchingView.tsx`
