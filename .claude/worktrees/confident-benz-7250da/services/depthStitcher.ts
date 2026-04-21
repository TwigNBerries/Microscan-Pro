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
