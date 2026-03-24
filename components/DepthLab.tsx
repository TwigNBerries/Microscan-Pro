
import React, { useState } from 'react';
import { DepthResult, CapturedImage, DepthMethod, GridDimensions, ScanSettings } from '../types';
import { Activity, RefreshCw, Map, CheckCircle, Clock, FolderDown, Download, Thermometer, FileText, Play, ArrowLeft, Combine, Trash2 } from 'lucide-react';
import JSZip from 'jszip';
import StitchingView from './StitchingView';

interface Props {
  results: Record<string, DepthResult>;
  capturedImages: Record<string, CapturedImage[]>;
  onTriggerDepth: (label: string, images: CapturedImage[], method: DepthMethod) => Promise<void>;
  onClearDepth: (label: string) => void;
  grid: GridDimensions;
  settings: ScanSettings;
}

const DepthLab: React.FC<Props> = ({ results, capturedImages, onTriggerDepth, onClearDepth, grid, settings }) => {
  const sortedLabels = Object.keys(capturedImages).sort();
  const [selectedMethod, setSelectedMethod] = useState<DepthMethod>('laplacian');

  const handleAnalyzeAll = async () => {
    const labels = sortedLabels.filter(l => !results[l] || !results[l].dataUrl);
    for (const label of labels) {
      await onTriggerDepth(label, capturedImages[label], selectedMethod);
    }
  };

  const generateCSV = (result: DepthResult) => {
    const { depthValues, width, height } = result;
    let csv = "";
    // Header: Column indices
    const header = Array.from({ length: width }, (_, i) => i).join(",");
    csv += "," + header + "\n";

    for (let y = 0; y < height; y++) {
      const row = [];
      row.push(y); // Row index as first column
      for (let x = 0; x < width; x++) {
        const val = depthValues[y * width + x];
        row.push(val.toFixed(4));
      }
      csv += row.join(",") + "\n";
    }
    return csv;
  };

  const handleDownloadCSV = (label: string) => {
    const result = results[label];
    if (!result || result.isProcessing) return;
    const csv = generateCSV(result);
    const blob = new Blob([csv], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Depth_Data_${label}.csv`;
    link.click();
  };

  const handleDownloadAllDepths = async () => {
    const finished = (Object.values(results) as DepthResult[]).filter(r => r.dataUrl && !r.isProcessing);
    if (finished.length === 0) return;
    
    const zip = new JSZip();
    finished.forEach(res => {
      zip.file(`Heatmap_${res.label}.jpg`, res.dataUrl.split(',')[1], { base64: true });
      zip.file(`Data_${res.label}.csv`, generateCSV(res));
    });
    
    const content = await zip.generateAsync({ type: "blob" });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = `Depth_Estimation_Project_${Date.now()}.zip`;
    link.click();
  };

  const [showStitching, setShowStitching] = useState(false);

  if (showStitching) {
    return (
      <div className="space-y-6">
        <button 
          onClick={() => setShowStitching(false)}
          className="px-4 py-2 bg-slate-800 text-white rounded-xl text-xs font-bold flex items-center gap-2 hover:bg-slate-700 transition-all"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Lab
        </button>
        <StitchingView 
          images={[]} 
          stackedResults={Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { label: k, dataUrl: v.dataUrl, isProcessing: v.isProcessing, sliceCount: 0 }]))} 
          grid={grid} 
          settings={settings} 
          title="Depth Topography Stitching"
        />
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-500 space-y-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
        <div>
          <h2 className="text-2xl font-black text-white flex items-center gap-3">
            Topographic Depth Lab
            <span className="px-2 py-0.5 bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 text-[10px] rounded-full font-black uppercase tracking-widest">Post-Process</span>
          </h2>
          <p className="text-xs text-slate-500 uppercase tracking-widest mt-1">Gaussian focus peak estimation for 3D surface reconstruction</p>
        </div>
        
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Focus Metric</label>
            <select 
              value={selectedMethod}
              onChange={(e) => setSelectedMethod(e.target.value as DepthMethod)}
              className="bg-slate-900 border border-slate-800 text-white text-xs font-bold rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-cyan-500/50 outline-none transition-all"
            >
              <option value="laplacian">Modified Laplacian</option>
              <option value="tenengrad">Tenengrad (Sobel)</option>
              <option value="wav1">WAV1 (Wavelet Sum)</option>
            </select>
          </div>
          
          <div className="flex gap-2 mt-auto">
            <button 
              onClick={handleAnalyzeAll}
              className="px-6 py-3 bg-slate-800 text-white rounded-2xl font-black text-xs border border-slate-700 hover:bg-slate-700 transition-all flex items-center gap-2"
            >
              <Play className="w-4 h-4" /> Analyze All
            </button>
            <button 
              onClick={() => setShowStitching(true)}
              className="px-6 py-3 bg-indigo-600 text-white rounded-2xl font-black text-xs shadow-xl flex items-center gap-2 hover:bg-indigo-500 transition-all"
            >
              <Combine className="w-4 h-4" /> Stitch Depth Map
            </button>
            <button 
              onClick={handleDownloadAllDepths}
              className="px-6 py-3 bg-cyan-500 text-slate-900 rounded-2xl font-black text-xs shadow-xl flex items-center gap-2 hover:bg-cyan-400 transition-all active:scale-95"
            >
              <FolderDown className="w-4 h-4" /> Export All Data
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {sortedLabels.length === 0 ? (
          <div className="col-span-full py-24 flex flex-col items-center justify-center bg-slate-900/30 rounded-[3rem] border-2 border-dashed border-slate-800">
             <Map className="w-16 h-16 text-slate-800 mb-4" />
             <p className="text-slate-500 font-black uppercase tracking-widest text-xs">Waiting for complete Z-stacks...</p>
          </div>
        ) : (
          sortedLabels.map(label => {
            const result = results[label];
            const images = capturedImages[label];

            return (
              <div key={label} className="bg-slate-900/50 border border-slate-800 rounded-[2rem] p-6 space-y-4 hover:border-cyan-500/30 transition-all group">
                <div className="flex justify-between items-center">
                   <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-slate-800 rounded-xl flex items-center justify-center text-cyan-400 font-black border border-slate-700">{label}</div>
                      <div>
                         <p className="text-[10px] font-black text-slate-500 uppercase">Surface Data</p>
                         <p className="text-xs font-bold text-white">{images.length} Focus Points</p>
                      </div>
                   </div>
                   
                   {result?.isProcessing ? (
                     <div className="px-3 py-1 bg-cyan-500/10 text-cyan-500 rounded-full text-[9px] font-black uppercase border border-cyan-500/20 flex items-center gap-2 animate-pulse">
                        <RefreshCw className="w-3 h-3 animate-spin" /> Computing
                     </div>
                   ) : result?.dataUrl ? (
                     <div className="px-3 py-1 bg-emerald-500/10 text-emerald-400 rounded-full text-[9px] font-black uppercase border border-emerald-500/20 flex items-center gap-2">
                        <CheckCircle className="w-3 h-3" /> {result.method.toUpperCase()}
                     </div>
                   ) : (
                     <button 
                       onClick={() => onTriggerDepth(label, images, selectedMethod)}
                       className="px-3 py-1 bg-cyan-500 text-slate-900 rounded-full text-[9px] font-black uppercase border border-cyan-500/20 flex items-center gap-2 hover:bg-cyan-400 transition-all"
                     >
                        <Play className="w-3 h-3 fill-current" /> Analyze
                     </button>
                   )}
                </div>

                <div className="relative aspect-video rounded-2xl overflow-hidden bg-black border border-slate-800">
                   {result?.dataUrl ? (
                     <img 
                       src={result.dataUrl} 
                       className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" 
                       alt="Depth Map"
                       referrerPolicy="no-referrer"
                     />
                   ) : images.length > 0 ? (
                     <div className="w-full h-full relative">
                        <img src={images[images.length - 1].dataUrl} className="w-full h-full object-cover blur-sm opacity-40" />
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                           <Activity className="w-8 h-8 text-slate-700" />
                           <p className="text-[10px] font-black text-slate-600 uppercase">Ready for Analysis</p>
                        </div>
                     </div>
                   ) : null}
                   
                   {result?.dataUrl && (
                     <div className="absolute top-3 left-3 px-3 py-1 bg-black/60 backdrop-blur-md rounded-lg border border-white/10 text-[9px] font-mono text-cyan-400 flex items-center gap-2">
                        <Thermometer className="w-3 h-3" /> {result.minZ.toFixed(3)}mm - {result.maxZ.toFixed(3)}mm
                     </div>
                   )}
                   
                   {result?.dataUrl && (
                     <div className="absolute bottom-3 right-3 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button 
                          onClick={() => onClearDepth(label)}
                          className="p-3 bg-rose-500/20 text-rose-500 rounded-xl hover:bg-rose-500 hover:text-white transition-all shadow-xl border border-rose-500/20"
                          title="Clear Result"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => handleDownloadCSV(label)}
                          className="p-3 bg-slate-800 text-cyan-400 rounded-xl hover:bg-slate-700 transition-all shadow-xl border border-white/10"
                          title="Download CSV Data"
                        >
                          <FileText className="w-4 h-4" />
                        </button>
                        <button 
                          onClick={() => { const link = document.createElement('a'); link.href = result.dataUrl; link.download = `Depth_${label}.jpg`; link.click(); }}
                          className="p-3 bg-cyan-500 text-slate-900 rounded-xl hover:bg-cyan-400 transition-all shadow-xl"
                          title="Download Heatmap"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                     </div>
                   )}
                </div>

                {result?.dataUrl && (
                  <div className="flex justify-between items-center px-2">
                    <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full bg-indigo-900" />
                        <span className="text-[8px] font-bold text-slate-500 uppercase">Deep</span>
                    </div>
                    <div className="flex-1 h-1 mx-4 bg-gradient-to-r from-indigo-900 via-emerald-500 to-yellow-400 rounded-full" />
                    <div className="flex items-center gap-2">
                        <span className="text-[8px] font-bold text-slate-500 uppercase">Shallow</span>
                        <div className="w-3 h-3 rounded-full bg-yellow-400" />
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default DepthLab;
