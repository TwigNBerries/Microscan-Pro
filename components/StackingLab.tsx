
import React from 'react';
import { StackResult, CapturedImage } from '../types';
import { Sparkles, RefreshCw, Layers, CheckCircle, Clock, FolderDown, Download } from 'lucide-react';
import JSZip from 'jszip';

interface Props {
  results: Record<string, StackResult>;
  capturedImages: Record<string, CapturedImage[]>;
}

const StackingLab: React.FC<Props> = ({ results, capturedImages }) => {
  const sortedLabels = Object.keys(capturedImages).sort();

  const handleDownloadAllMasters = async () => {
    // Explicitly cast Object.values to StackResult[] to resolve 'unknown' type errors in certain environments
    const finished = (Object.values(results) as StackResult[]).filter(r => r.dataUrl && !r.isProcessing);
    if (finished.length === 0) return;
    
    const zip = new JSZip();
    finished.forEach(res => {
      zip.file(`${res.label}.jpg`, res.dataUrl.split(',')[1], { base64: true });
    });
    
    const content = await zip.generateAsync({ type: "blob" });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = `Optimized_Stacks_${Date.now()}.zip`;
    link.click();
  };

  return (
    <div className="animate-in fade-in duration-500 space-y-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
        <div>
          <h2 className="text-2xl font-black text-white flex items-center gap-3">
            Focus Stacking Lab
            <span className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[10px] rounded-full font-black uppercase tracking-widest">Automatic</span>
          </h2>
          <p className="text-xs text-slate-500 uppercase tracking-widest mt-1">Merging Z-slices into composite "all-in-focus" masters</p>
        </div>
        <button 
          onClick={handleDownloadAllMasters}
          className="px-6 py-3 bg-amber-500 text-slate-900 rounded-2xl font-black text-xs shadow-xl flex items-center gap-2 hover:bg-amber-400 transition-all active:scale-95"
        >
          <FolderDown className="w-4 h-4" /> Export All Masters
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {sortedLabels.length === 0 ? (
          <div className="col-span-full py-24 flex flex-col items-center justify-center bg-slate-900/30 rounded-[3rem] border-2 border-dashed border-slate-800">
             <Layers className="w-16 h-16 text-slate-800 mb-4" />
             <p className="text-slate-500 font-black uppercase tracking-widest text-xs">Waiting for complete Z-stacks...</p>
          </div>
        ) : (
          sortedLabels.map(label => {
            const result = results[label];
            const images = capturedImages[label];

            return (
              <div key={label} className="bg-slate-900/50 border border-slate-800 rounded-[2rem] p-6 space-y-4 hover:border-amber-500/30 transition-all group">
                <div className="flex justify-between items-center">
                   <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-slate-800 rounded-xl flex items-center justify-center text-amber-500 font-black border border-slate-700">{label}</div>
                      <div>
                         <p className="text-[10px] font-black text-slate-500 uppercase">Coordinate Stack</p>
                         <p className="text-xs font-bold text-white">{images.length} Slices</p>
                      </div>
                   </div>
                   
                   {result?.isProcessing ? (
                     <div className="px-3 py-1 bg-amber-500/10 text-amber-500 rounded-full text-[9px] font-black uppercase border border-amber-500/20 flex items-center gap-2 animate-pulse">
                        <RefreshCw className="w-3 h-3 animate-spin" /> Processing
                     </div>
                   ) : result?.dataUrl ? (
                     <div className="px-3 py-1 bg-emerald-500/10 text-emerald-400 rounded-full text-[9px] font-black uppercase border border-emerald-500/20 flex items-center gap-2">
                        <CheckCircle className="w-3 h-3" /> Sharp
                     </div>
                   ) : (
                     <div className="px-3 py-1 bg-slate-800 text-slate-500 rounded-full text-[9px] font-black uppercase border border-slate-700 flex items-center gap-2">
                        <Clock className="w-3 h-3" /> Waiting
                     </div>
                   )}
                </div>

                <div className="relative aspect-video rounded-2xl overflow-hidden bg-black border border-slate-800">
                   {result?.dataUrl ? (
                     <img src={result.dataUrl} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" />
                   ) : images.length > 0 ? (
                     <div className="w-full h-full relative">
                        <img src={images[images.length - 1].dataUrl} className="w-full h-full object-cover blur-sm opacity-40" />
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                           <Layers className="w-8 h-8 text-slate-700" />
                           <p className="text-[10px] font-black text-slate-600 uppercase">Processing...</p>
                        </div>
                     </div>
                   ) : null}
                   
                   {result?.dataUrl && (
                     <div className="absolute top-3 left-3 px-3 py-1 bg-black/60 backdrop-blur-md rounded-lg border border-white/10 text-[9px] font-mono text-amber-400 flex items-center gap-2">
                        <Sparkles className="w-3 h-3" /> OPTIMIZED
                     </div>
                   )}
                   
                   {result?.dataUrl && (
                     <button 
                       onClick={() => { const link = document.createElement('a'); link.href = result.dataUrl; link.download = `${label}.jpg`; link.click(); }}
                       className="absolute bottom-3 right-3 p-3 bg-amber-500 text-slate-900 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity shadow-xl"
                     >
                       <Download className="w-4 h-4" />
                     </button>
                   )}
                </div>

                <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                  {images.map(img => (
                    <div key={img.id} className="w-12 h-12 rounded-lg bg-black border border-slate-800 shrink-0 overflow-hidden">
                       <img src={img.dataUrl} className="w-full h-full object-cover opacity-60" />
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default StackingLab;
