
import React, { useRef, useState, useMemo } from 'react';
import { CapturedImage, GridDimensions, ScanSettings, StackResult } from '../types';
import { Download, ZoomIn, ZoomOut, Combine, ArrowLeft, Loader2, RotateCcw } from 'lucide-react';
import { getAlphabetLabel } from '../services/gcodeService';

interface Props {
  images: CapturedImage[];
  stackedResults: Record<string, StackResult>;
  grid: GridDimensions;
  settings: ScanSettings;
  title?: string;
  depthDecoration?: { minMm: number; maxMm: number };
}

/**
 * Draws full depth-map decorations onto the canvas: colorbar (right), X-axis (bottom),
 * Y-axis (left), and a thin border around the mosaic area.
 *
 * @param mosaicX/mosaicY — top-left of the mosaic image in canvas coordinates
 * @param mW/mH — pixel dimensions of the mosaic
 * @param minMm/maxMm — Z-height range for the colorbar (mm)
 * @param widthMm/heightMm — physical X/Y dimensions of the mosaic (mm)
 * @param fs — base font size (pixels)
 */
function drawDepthDecorations(
  ctx: CanvasRenderingContext2D,
  mosaicX: number, mosaicY: number, mW: number, mH: number,
  minMm: number, maxMm: number,
  widthMm: number, heightMm: number,
  fs: number
) {
  const titleFs = Math.round(fs * 1.15);

  // ---- Colorbar (right of mosaic) ----
  const cbGap = Math.round(fs * 0.8);
  const cbW = Math.round(fs * 1.8);
  const cbX = mosaicX + mW + cbGap;
  const cbPad = Math.round(mH * 0.04);
  const cbH = mH - cbPad * 2;
  const cbY = mosaicY + cbPad;

  const grad = ctx.createLinearGradient(0, cbY, 0, cbY + cbH);
  grad.addColorStop(0.00, '#7a0403');
  grad.addColorStop(0.12, '#c93803');
  grad.addColorStop(0.25, '#f88605');
  grad.addColorStop(0.38, '#f9df24');
  grad.addColorStop(0.50, '#45ec85');
  grad.addColorStop(0.62, '#28b9c4');
  grad.addColorStop(0.75, '#4777ef');
  grad.addColorStop(0.88, '#4747c4');
  grad.addColorStop(1.00, '#30123b');
  ctx.fillStyle = grad;
  ctx.fillRect(cbX, cbY, cbW, cbH);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(cbX, cbY, cbW, cbH);

  ctx.font = `bold ${fs}px monospace`;
  ctx.textAlign = 'left';
  const numCbTicks = 5;
  for (let i = 0; i <= numCbTicks; i++) {
    const frac = i / numCbTicks;
    const tickY = cbY + cbH * (1 - frac);
    const val = minMm + frac * (maxMm - minMm);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(cbX + cbW, tickY - 1, Math.round(fs * 0.5), 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(val.toFixed(2), cbX + cbW + Math.round(fs * 0.7), tickY + fs * 0.35);
  }

  ctx.save();
  ctx.translate(cbX + cbW + Math.round(fs * 5.5), cbY + cbH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.font = `bold ${titleFs}px monospace`;
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('Z (mm)', 0, 0);
  ctx.restore();

  // ---- X axis (below mosaic) ----
  ctx.font = `bold ${fs}px monospace`;
  ctx.textAlign = 'center';
  const numXTicks = 5;
  const xAxisY = mosaicY + mH;
  for (let i = 0; i <= numXTicks; i++) {
    const frac = i / numXTicks;
    const tickX = mosaicX + mW * frac;
    const val = widthMm * frac;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(tickX - 1, xAxisY, 2, Math.round(fs * 0.5));
    ctx.fillStyle = '#ffffff';
    ctx.fillText(val.toFixed(2), tickX, xAxisY + fs * 1.5);
  }
  ctx.font = `bold ${titleFs}px monospace`;
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('Width (mm)', mosaicX + mW / 2, xAxisY + fs * 3);

  // ---- Y axis (left of mosaic) ----
  ctx.font = `bold ${fs}px monospace`;
  ctx.textAlign = 'right';
  const numYTicks = 5;
  for (let i = 0; i <= numYTicks; i++) {
    const frac = i / numYTicks;
    const tickY = mosaicY + mH * frac;
    const val = heightMm * frac;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(mosaicX - Math.round(fs * 0.5), tickY - 1, Math.round(fs * 0.5), 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(val.toFixed(2), mosaicX - Math.round(fs * 0.7), tickY + fs * 0.35);
  }
  ctx.save();
  ctx.translate(mosaicX - Math.round(fs * 4), mosaicY + mH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.font = `bold ${titleFs}px monospace`;
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('Height (mm)', 0, 0);
  ctx.restore();

  // ---- Mosaic border ----
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(mosaicX, mosaicY, mW, mH);
}

const StitchingView: React.FC<Props> = ({ images, stackedResults, grid, settings, title = "Stitching Laboratory", depthDecoration }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(0.8);
  const [isStitching, setIsStitching] = useState(false);
  const [hasStitched, setHasStitched] = useState(false);
  const [stitchedDataUrl, setStitchedDataUrl] = useState<string | null>(null);
  const [stitchProgress, setStitchProgress] = useState(0);
  const [rotateFrames, setRotateFrames] = useState(false);

  const tileMap = useMemo(() => {
    const map: Record<string, { dataUrl: string; isOptimized: boolean }> = {};
    (Object.values(stackedResults) as StackResult[]).forEach(res => {
      if (res.dataUrl) map[res.label] = { dataUrl: res.dataUrl, isOptimized: true };
    });
    images.forEach(img => {
      if (!map[img.label]) map[img.label] = { dataUrl: img.dataUrl, isOptimized: false };
    });
    return map;
  }, [images, stackedResults]);

  /**
   * Loads an image URL into an ImageData, optionally rotating 180° before returning.
   * The 180° rotation is done via a canvas transform — equivalent to flipping both
   * horizontally and vertically, which corrects the DinoCapture digital-rotation artifact.
   */
  const getImageData = async (url: string, rotate180: boolean = false): Promise<ImageData> => {
    const img = new Image();
    img.src = url;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    if (rotate180) {
      ctx.translate(img.width / 2, img.height / 2);
      ctx.rotate(Math.PI);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
    } else {
      ctx.drawImage(img, 0, 0);
    }
    return ctx.getImageData(0, 0, img.width, img.height);
  };

  const handleDownloadMosaic = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Full_Micro_Mosaic_${Date.now()}.jpg`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 100);
    }, 'image/jpeg', 0.95);
  };

  const blendHorizontal = (left: ImageData, right: ImageData, overlapPercent: number): ImageData => {
    const overlapWidth = Math.round(right.width * (overlapPercent / 100));
    const outWidth = left.width + right.width - overlapWidth;
    const outHeight = Math.max(left.height, right.height);
    const result = new ImageData(outWidth, outHeight);
    const L = left.data; const R = right.data; const D = result.data;

    for (let y = 0; y < outHeight; y++) {
      for (let x = 0; x < outWidth; x++) {
        const destIdx = (y * outWidth + x) * 4;
        if (x < left.width - overlapWidth) {
          if (y < left.height) {
            const srcIdx = (y * left.width + x) * 4;
            D[destIdx] = L[srcIdx]; D[destIdx + 1] = L[srcIdx + 1]; D[destIdx + 2] = L[srcIdx + 2]; D[destIdx + 3] = 255;
          }
        } else if (x < left.width) {
          const overlapIdx = x - (left.width - overlapWidth);
          const alpha = overlapIdx / overlapWidth;
          if (y < left.height && y < right.height) {
            const lIdx = (y * left.width + x) * 4;
            const rIdx = (y * right.width + overlapIdx) * 4;
            D[destIdx] = Math.round(L[lIdx] * (1 - alpha) + R[rIdx] * alpha);
            D[destIdx + 1] = Math.round(L[lIdx + 1] * (1 - alpha) + R[rIdx + 1] * alpha);
            D[destIdx + 2] = Math.round(L[lIdx + 2] * (1 - alpha) + R[rIdx + 2] * alpha);
            D[destIdx + 3] = 255;
          }
        } else {
          const rightX = x - (left.width - overlapWidth);
          if (y < right.height) {
            const srcIdx = (y * right.width + rightX) * 4;
            D[destIdx] = R[srcIdx]; D[destIdx + 1] = R[srcIdx + 1]; D[destIdx + 2] = R[srcIdx + 2]; D[destIdx + 3] = 255;
          }
        }
      }
    }
    return result;
  };

  const blendVertical = (top: ImageData, bottom: ImageData, overlapPercent: number): ImageData => {
    const overlapHeight = Math.round(bottom.height * (overlapPercent / 100));
    const outWidth = Math.max(top.width, bottom.width);
    const outHeight = top.height + bottom.height - overlapHeight;
    const result = new ImageData(outWidth, outHeight);
    const T = top.data; const B = bottom.data; const D = result.data;

    for (let y = 0; y < outHeight; y++) {
      for (let x = 0; x < outWidth; x++) {
        const destIdx = (y * outWidth + x) * 4;
        if (y < top.height - overlapHeight) {
          if (x < top.width) {
            const srcIdx = (y * top.width + x) * 4;
            D[destIdx] = T[srcIdx]; D[destIdx + 1] = T[srcIdx + 1]; D[destIdx + 2] = T[srcIdx + 2]; D[destIdx + 3] = 255;
          }
        } else if (y < top.height) {
          const overlapIdx = y - (top.height - overlapHeight);
          const alpha = overlapIdx / overlapHeight;
          if (x < top.width && x < bottom.width) {
            const tIdx = (y * top.width + x) * 4;
            const bIdx = (overlapIdx * bottom.width + x) * 4;
            D[destIdx] = Math.round(T[tIdx] * (1 - alpha) + B[bIdx] * alpha);
            D[destIdx + 1] = Math.round(T[tIdx + 1] * (1 - alpha) + B[bIdx + 1] * alpha);
            D[destIdx + 2] = Math.round(T[tIdx + 2] * (1 - alpha) + B[bIdx + 2] * alpha);
            D[destIdx + 3] = 255;
          }
        } else {
          const bottomY = y - (top.height - overlapHeight);
          if (x < bottom.width) {
            const srcIdx = (bottomY * bottom.width + x) * 4;
            D[destIdx] = B[srcIdx]; D[destIdx + 1] = B[srcIdx + 1]; D[destIdx + 2] = B[srcIdx + 2]; D[destIdx + 3] = 255;
          }
        }
      }
    }
    return result;
  };

  const executeHierarchicalStitch = async () => {
    if (Object.keys(tileMap).length === 0) return;
    setIsStitching(true);
    setStitchProgress(0);
    try {
      const rowMosaics: ImageData[] = [];
      for (let r = 0; r < grid.rows; r++) {
        setStitchProgress(Math.floor((r / grid.rows) * 50));
        const rowLabel = getAlphabetLabel(r);
        let currentRowMosaic: ImageData | null = null;
        for (let c = 0; c < grid.cols; c++) {
          const label = `${rowLabel}${c + 1}`;
          const tileData = tileMap[label];
          if (!tileData) continue;
          // Pass rotateFrames into getImageData so each tile is corrected before blending
          const currentTileImageData = await getImageData(tileData.dataUrl, rotateFrames);
          if (!currentRowMosaic) currentRowMosaic = currentTileImageData;
          else currentRowMosaic = blendHorizontal(currentRowMosaic, currentTileImageData, settings.overlapPercent);
        }
        if (currentRowMosaic) rowMosaics.push(currentRowMosaic);
      }
      if (rowMosaics.length === 0) { setIsStitching(false); return; }
      let finalMosaic = rowMosaics[0];
      for (let i = 1; i < rowMosaics.length; i++) {
        setStitchProgress(50 + Math.floor((i / rowMosaics.length) * 50));
        finalMosaic = blendVertical(finalMosaic, rowMosaics[i], settings.overlapPercent);
      }
      const canvas = canvasRef.current;
      if (canvas) {
        if (depthDecoration) {
          // Put mosaic on a temp canvas, then draw onto a larger canvas with axes + colorbar
          const tmp = document.createElement('canvas');
          tmp.width = finalMosaic.width;
          tmp.height = finalMosaic.height;
          tmp.getContext('2d')!.putImageData(finalMosaic, 0, 0);

          const mW = finalMosaic.width;
          const mH = finalMosaic.height;
          const fs = Math.max(18, Math.min(48, Math.round(Math.min(mW, mH) / 25)));

          const leftPad = Math.round(fs * 5.5);
          const topPad = Math.round(fs * 1.5);
          const bottomPad = Math.round(fs * 4.5);
          const cbGap = Math.round(fs * 0.8);
          const cbW = Math.round(fs * 1.8);
          const cbLblW = Math.round(fs * 7);

          canvas.width = leftPad + mW + cbGap + cbW + cbLblW;
          canvas.height = topPad + mH + bottomPad;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(tmp, leftPad, topPad);

          const totalWidthMm = grid.fovX + (grid.cols - 1) * grid.stepX;
          const totalHeightMm = grid.fovY + (grid.rows - 1) * grid.stepY;

          drawDepthDecorations(ctx, leftPad, topPad, mW, mH,
            depthDecoration.minMm, depthDecoration.maxMm,
            totalWidthMm, totalHeightMm, fs);
        } else {
          canvas.width = finalMosaic.width;
          canvas.height = finalMosaic.height;
          const ctx = canvas.getContext('2d')!;
          ctx.putImageData(finalMosaic, 0, 0);
        }
        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        setStitchedDataUrl(dataUrl); setHasStitched(true);
      }
    } catch (err) { console.error("Stitching failed:", err); }
    finally { setIsStitching(false); setStitchProgress(100); }
  };

  return (
    <div className="flex flex-col gap-8 animate-in fade-in duration-500 h-full">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
        <div>
          <h2 className="text-2xl font-black text-white flex items-center gap-3">{title}</h2>
          <p className="text-xs text-slate-500 uppercase tracking-widest mt-1">{grid.cols}x{grid.rows} Matrix • {settings.overlapPercent}% Overlap</p>
        </div>
        <div className="flex gap-3 items-center flex-wrap justify-end">
          {/* Rotation correction toggle — enables 180° correction for DinoCapture-rotated feeds */}
          <button
            onClick={() => { setRotateFrames(r => !r); setHasStitched(false); setStitchedDataUrl(null); }}
            title="Toggle 180° frame rotation correction (use when DinoCapture has digitally rotated the camera feed)"
            className={`px-5 py-3 rounded-2xl font-black text-xs border flex items-center gap-2 transition-all ${
              rotateFrames
                ? 'bg-violet-500 text-white border-violet-400 shadow-lg shadow-violet-500/30'
                : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-white'
            }`}
          >
            <RotateCcw className="w-4 h-4" />
            180° Correction {rotateFrames ? 'ON' : 'OFF'}
          </button>

          {hasStitched ? (
            <>
              <button onClick={() => { setHasStitched(false); setStitchedDataUrl(null); }} className="px-6 py-3 bg-slate-800 text-slate-400 rounded-2xl font-black text-xs border border-slate-700 hover:text-white transition-all flex items-center gap-2"><ArrowLeft className="w-4 h-4" /> Reset</button>
              <button onClick={handleDownloadMosaic} className="px-6 py-3 bg-emerald-500 text-slate-900 rounded-2xl font-black text-xs shadow-xl flex items-center gap-2 hover:bg-emerald-400 transition-all"><Download className="w-4 h-4" /> Export Mosaic</button>
            </>
          ) : (
            <button onClick={executeHierarchicalStitch} disabled={isStitching} className="px-8 py-3 bg-cyan-500 text-slate-900 rounded-2xl font-black text-xs shadow-xl flex items-center gap-2 disabled:opacity-30">
              {isStitching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Combine className="w-4 h-4" />} Stitch Mosaic
            </button>
          )}
        </div>
      </div>

      <div className="w-full h-[600px] bg-slate-950 border border-slate-800 rounded-[3rem] overflow-hidden relative shadow-2xl flex items-center justify-center p-8">
        {!hasStitched ? (
          <div
            className="grid gap-2 overflow-auto max-h-full max-w-full"
            style={{ gridTemplateColumns: `repeat(${grid.cols}, minmax(100px, 1fr))`, transform: `scale(${zoom})` }}
          >
            {Array.from({ length: grid.rows }).map((_, r) =>
              Array.from({ length: grid.cols }).map((_, c) => {
                const label = `${getAlphabetLabel(r)}${c + 1}`;
                const tile = tileMap[label];
                return (
                  <div
                    key={label}
                    className={`aspect-video rounded-lg border flex items-center justify-center relative overflow-hidden ${
                      tile
                        ? tile.isOptimized
                          ? 'border-amber-500/50 bg-slate-900'
                          : 'border-cyan-500/50 bg-slate-900'
                        : 'border-slate-800 border-dashed bg-slate-900/50'
                    }`}
                  >
                    {tile && (
                      <img
                        src={tile.dataUrl}
                        className="w-full h-full object-cover"
                        style={{ transform: rotateFrames ? 'rotate(180deg)' : 'none' }}
                      />
                    )}
                    <span className="absolute bottom-1 right-1 text-[8px] font-black text-white/50">{label}</span>
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center overflow-auto scrollbar-hide">
            <img
              src={stitchedDataUrl!}
              className="max-h-full shadow-2xl rounded-lg transition-transform duration-300"
              style={{ transform: `scale(${zoom})` }}
            />
          </div>
        )}

        {isStitching && (
          <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-md flex flex-col items-center justify-center z-50">
            <Loader2 className="w-10 h-10 text-cyan-500 animate-spin mb-4" />
            <h3 className="text-white font-black uppercase tracking-widest text-sm">Executing Hierarchical Stitch... ({stitchProgress}%)</h3>
            <p className="text-[10px] text-slate-500 mt-2 uppercase tracking-[0.2em]">Applying Bilinear Alpha Blending</p>
          </div>
        )}

        <div className="absolute bottom-8 right-8 flex bg-black/80 backdrop-blur-2xl p-1 rounded-xl border border-white/10 shadow-2xl">
          <button onClick={() => setZoom(z => Math.max(0.1, z - 0.1))} className="p-2 text-slate-400 hover:text-white transition-colors"><ZoomOut className="w-4 h-4" /></button>
          <div className="px-3 flex items-center text-[10px] font-black text-cyan-400 border-x border-white/10">{Math.round(zoom * 100)}%</div>
          <button onClick={() => setZoom(z => Math.min(3, z + 0.1))} className="p-2 text-slate-400 hover:text-white transition-colors"><ZoomIn className="w-4 h-4" /></button>
        </div>
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

export default StitchingView;
