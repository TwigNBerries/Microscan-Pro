# Stitched XYZ Export — Design

## Goal

Export every tile's depth data as a single stitched `.xyz` file in the same tab-separated `X_um\tY_um\tZ_um` format as the existing per-tile `Depth_Data_<label>.xyz` export. The stitched file must preserve tile orientation, support 180° rotation correction (matching the image-stitching flow), and represent overlap regions as seamlessly-blended Z values rather than duplicate points.

## Non-goals

- Point-cloud output (`.ply`, unstitched `.xyz` scatter).
- Changing the existing Z unit convention. `DepthResult.depthValues` is already in microns (converted from mm in `services/depthService.ts` line 173), so the file's `Z_um` header matches its values. The stitched export writes `depthValues` verbatim for parity.
- Re-decoding the heatmap JPEG — raw `depthValues` arrays are used directly.
- Changes to the image stitcher (`StitchingView`) or to `depth_processor.py`.

## Output format

Byte-for-byte compatible with the existing per-tile XYZ file:

```
X_um\tY_um\tZ_um
0.0000\t0.0000\t948.1481
3.1214\t0.0000\t677.6808
...
```

- Tab-separated, `\n` line endings.
- Header row: `X_um\tY_um\tZ_um\n`.
- Raster scan order: Y outer loop, X inner loop.
- Numeric fields: `.toFixed(4)`.
- Missing / invalid cells: literal text `NaN` in the Z column (X and Y still emitted — grid stays rectangular).
- Filename: `Depth_Stitched_<timestamp>.xyz`.

## Architecture

### New module

`services/depthService.ts` gains one exported pure function:

```ts
stitchDepthToXYZ(
  results: Record<string, DepthResult>,
  grid: GridDimensions,
  settings: ScanSettings,
  rotate180: boolean
): Blob
```

No React, no DOM side effects beyond returning a `Blob`. Callers are responsible for triggering the download.

### UI surface

`components/DepthLab.tsx`:
- New **"Export Stitched XYZ"** button next to the existing **"Export All Data"** button in the header action row.
- New **"180° Correction"** toggle in the same row, mirroring the one in `StitchingView`. Local component state.
- Button disabled while any tile is processing or when zero tiles have finished.
- Small inline spinner on the button label while `stitchDepthToXYZ` runs.

No changes to `StitchingView.tsx`.

## Algorithm

### Global grid setup

```
specs        = getInterpolatedData(settings.magnification)
tileW, tileH = depthValues dimensions (must be consistent across tiles)
pixelSizeUm  = (specs.fovX * 1000) / tileW

totalWidthMm  = grid.fovX + (grid.cols - 1) * grid.stepX
totalHeightMm = grid.fovY + (grid.rows - 1) * grid.stepY

globalW = round(totalWidthMm  * 1000 / pixelSizeUm)
globalH = round(totalHeightMm * 1000 / pixelSizeUm)
```

### Feather-blended accumulation

Two `Float32Array(globalW * globalH)` buffers: `zAccum` (weighted sum) and `wAccum` (weight sum).

For each tile at grid position `(row, col)` with label `${alphabetLabel(row)}${col+1}`:

```
tileX0_px = round(col * grid.stepX * 1000 / pixelSizeUm)
tileY0_px = round(row * grid.stepY * 1000 / pixelSizeUm)
overlapPx = round(tileW * settings.overlapPercent / 100)

for py in 0..tileH-1:
  for px in 0..tileW-1:
    srcPx = rotate180 ? (tileW - 1 - px) : px
    srcPy = rotate180 ? (tileH - 1 - py) : py
    z = result.depthValues[srcPy * tileW + srcPx]
    if (!isFinite(z)) continue
    w = featherAlpha(px, py, tileW, tileH, overlapPx, hasLeft, hasRight, hasTop, hasBottom)
    gi = (tileY0_px + py) * globalW + (tileX0_px + px)
    zAccum[gi] += z * w
    wAccum[gi] += w
```

`featherAlpha` returns a 1D bilinear ramp on each edge that has a neighbor tile (`hasLeft`/`hasRight`/`hasTop`/`hasBottom`). Outer edges of the mosaic get full weight. Inside the non-overlap core of every tile the weight is `1.0`. This matches the blending semantics of `blendHorizontal` / `blendVertical` in `StitchingView.tsx`, applied to a scalar Z instead of RGB channels.

### Grid finalisation

```
for gi in 0..globalW*globalH-1:
  zGrid[gi] = wAccum[gi] > 0 ? zAccum[gi] / wAccum[gi] : NaN
```

### Serialization

Chunked Blob construction, matching `handleDownloadXYZ` in `DepthLab.tsx`:

```
parts = ["X_um\tY_um\tZ_um\n"]
chunk = []
for gy in 0..globalH-1:
  yStr = (gy * pixelSizeUm).toFixed(4)
  for gx in 0..globalW-1:
    xStr = (gx * pixelSizeUm).toFixed(4)
    z = zGrid[gy * globalW + gx]
    zStr = isFinite(z) ? z.toFixed(4) : "NaN"
    chunk.push(`${xStr}\t${yStr}\t${zStr}\n`)
    if (chunk.length > 50000) { parts.push(chunk.join("")); chunk = [] }
if (chunk.length) parts.push(chunk.join(""))
return new Blob(parts, { type: "text/plain" })
```

## Data flow

```
DepthLab "Export Stitched XYZ" click
  → read results / grid / settings / rotate180 state
  → stitchDepthToXYZ(...) in services/depthService.ts
      → build zAccum / wAccum buffers
      → for each tile: feather-weighted Z accumulation
      → finalise zGrid (divide or NaN)
      → chunked Blob of raster-scan XYZ rows
  → create object URL, trigger <a download>, revoke URL
```

## Edge cases

- **Missing tile** (no `DepthResult` or `depthValues.length === 0`): skip its accumulation pass. The cells that only that tile would have covered stay at `wAccum = 0` → `NaN` in output. File remains rectangular.
- **Tiles with mismatched `width`/`height`**: the first finished tile defines `tileW`/`tileH`. Tiles whose dimensions differ are skipped with a `console.warn` and their region is emitted as `NaN`. (This should not happen in practice — same camera, same downscale — but is handled defensively.)
- **Tile contains only NaNs**: no points accumulate; region becomes `NaN`.
- **Button state**: disabled when `Object.values(results).filter(r => r.dataUrl && !r.isProcessing).length === 0` or when any tile has `isProcessing`.
- **Rotation toggle**: affects only the per-tile index lookup. Grid placement math is unchanged — physical tile positions are not rotated, only each tile's pixel data is flipped in place (same semantics as `StitchingView.rotateFrames`).
- **Large output**: a 6×6 grid of 1920×1080 tiles at 20% overlap produces ~50 MP of cells (~2 GB text). The chunked Blob pattern keeps the JS heap bounded; the final file size is what it is. No streaming-to-disk is attempted — this is consistent with the existing `handleDownloadXYZ` approach.

## Testing

Unit tests for `stitchDepthToXYZ` in `services/depthService.test.ts`:

1. **Single tile, no rotation** — output equals the per-tile XYZ for that tile (identical rows and order).
2. **Single tile, rotation on** — output rows have `Z` values that mirror the tile 180° versus case 1.
3. **2×1 grid, 0% overlap** — no blending path exercised; each global cell sourced from exactly one tile; no `NaN` in output interior.
4. **2×1 grid, 20% overlap** — cells in the overlap column equal the exact blended midpoint when both tiles have constant Z, and equal the weighted average when Z differs per tile.
5. **Missing tile in 2×2 grid** — the quadrant matching the missing tile emits `NaN` rows; other quadrants emit valid Z.
6. **NaN in input `depthValues`** — output cell that corresponds only to the NaN pixel emits `NaN`; output cell that is also covered by a neighbor's valid pixel emits that neighbor's value.
7. **Header and format** — first line is exactly `X_um\tY_um\tZ_um\n`; every other line has exactly 3 tab-separated fields with `.toFixed(4)` formatting or literal `NaN`.

Manual verification:
- Export one tile via the existing per-tile button and via the new stitched export on a 1×1 grid; diff the two files — should be identical (ignoring the filename).
- Export a multi-tile scan; open in Gwyddion as "XYZ data" → confirm the heightmap orientation, physical dimensions, and seam continuity match the stitched image mosaic.
- Export with 180° toggle on and off → confirm the resulting Gwyddion heightmap flips accordingly.
