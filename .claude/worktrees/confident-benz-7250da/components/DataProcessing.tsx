import React, { useMemo, useRef, useState, useEffect } from 'react';
import { DepthResult, GridDimensions, ScanSettings } from '../types';
import { Sliders, Play, X, FileOutput, RotateCcw, Loader2 } from 'lucide-react';
import { FilterConfig, DEFAULT_FILTER_CONFIG, applyPipeline } from '../services/depthFilters';
import { DepthFilterPool, FilterProgress } from '../services/depthFilterPool';
import { renderDepthToCanvas, downsample } from '../services/depthHeatmapCanvas';
import { stitchDepthToXYZ } from '../services/depthStitcher';

interface Props {
  results: Record<string, DepthResult>;
  filteredResults: Record<string, DepthResult>;
  setFilteredResults: React.Dispatch<React.SetStateAction<Record<string, DepthResult>>>;
  grid: GridDimensions;
  settings: ScanSettings;
  rotateFrames: boolean;
}

const DataProcessing: React.FC<Props> = ({
  results, filteredResults, setFilteredResults, grid, settings, rotateFrames,
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
  const [applyInProgress, setApplyInProgress] = useState(false);
  const [applyProgress, setApplyProgress] = useState<FilterProgress | null>(null);
  const poolRef = useRef<DepthFilterPool | null>(null);
  const rawCanvasRef = useRef<HTMLCanvasElement>(null);
  const filteredCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const r = results[previewLabel];
    if (!r || !r.depthValues.length) return;
    const depthF32 = new Float32Array(r.depthValues);
    const ds = downsample(depthF32, r.width, r.height, 1024);
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

  const handleApplyToAll = async () => {
    if (applyInProgress) return;
    const jobs = finishedLabels
      .filter(l => {
        const r = results[l];
        return r && r.depthValues.length > 0;
      })
      .map(l => {
        const r = results[l];
        return { label: l, src: new Float32Array(r.depthValues), w: r.width, h: r.height };
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
              depthValues: Array.from(r.filtered) as number[],
              minZ: minZ / 1000,
              maxZ: maxZ / 1000,
              method: ((source.method ?? '') + '+filtered') as DepthResult['method'],
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
          <button
            onClick={handleExportFilteredStitched}
            disabled={isExporting || Object.keys(filteredResults).length === 0 || applyInProgress}
            title="Stitch filtered tiles into one XYZ file"
            className="px-6 py-3 bg-amber-500 text-slate-900 rounded-2xl font-black text-xs shadow-xl flex items-center gap-2 hover:bg-amber-400 transition-all disabled:opacity-30"
          >
            {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileOutput className="w-4 h-4" />}
            Export Filtered Stitched XYZ
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
    </div>
  );
};

export default DataProcessing;
