
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  ArrowUp, 
  ArrowDown, 
  ArrowLeft, 
  ArrowRight, 
  Home, 
  Crosshair, 
  Unlock, 
  Activity, 
  Loader2, 
  FastForward,
  Keyboard,
  MoveUp,
  MoveDown,
  Target,
  Camera,
  Trash2,
  Download,
  ImageIcon
} from 'lucide-react';
import { CapturedImage } from '../types';

interface Props {
  onSendCommand: (cmd: string) => Promise<void>;
  onJog: (axis: 'X' | 'Y' | 'Z', distance: number, feedrate: number) => Promise<void>;
  onCapture: () => boolean;
  manualCaptures: CapturedImage[];
  setManualCaptures: React.Dispatch<React.SetStateAction<CapturedImage[]>>;
  isConnected: boolean;
  isPrinterReady: boolean;
  queueSize: number;
  stepSize: number;
  setStepSize: (s: number) => void;
  feedrate: number;
  setFeedrate: (f: number) => void;
}

const ManualCapture: React.FC<Props> = ({ 
  onSendCommand, 
  onJog,
  onCapture,
  manualCaptures,
  setManualCaptures,
  isConnected, 
  isPrinterReady, 
  queueSize,
  stepSize,
  setStepSize,
  feedrate,
  setFeedrate
}) => {
  const lastCommandTime = useRef<number>(0);

  const jog = useCallback(async (axis: 'X' | 'Y' | 'Z', distance: number) => {
    if (!isConnected) return;
    
    // Throttle UI commands
    const now = Date.now();
    if (now - lastCommandTime.current < 80) return; 
    lastCommandTime.current = now;

    await onJog(axis, distance, feedrate);
  }, [isConnected, onJog, feedrate]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isConnected || document.activeElement?.tagName === 'INPUT') return;
      if (queueSize > 2) return; 

      switch (e.key) {
        case 'ArrowUp': jog('Y', stepSize); break; 
        case 'ArrowDown': jog('Y', -stepSize); break;
        case 'ArrowLeft': jog('X', -stepSize); break;
        case 'ArrowRight': jog('X', stepSize); break;
        case 'PageUp': jog('Z', stepSize); break;
        case 'PageDown': jog('Z', -stepSize); break;
        case 'Enter': 
          if (e.ctrlKey || e.metaKey) {
            onCapture();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isConnected, queueSize, jog, stepSize, onCapture]);

  const handleDelete = (id: string) => {
    setManualCaptures(prev => prev.filter(img => img.id !== id));
  };

  const downloadImage = (img: CapturedImage) => {
    const link = document.createElement('a');
    link.href = img.dataUrl;
    link.download = `${img.name}.jpg`;
    link.click();
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Controls */}
        <div className="lg:col-span-7 space-y-6">
          <div className="bg-slate-900/50 border border-slate-800 rounded-3xl p-8 shadow-xl backdrop-blur-sm">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-500/10 rounded-lg text-amber-500"><Activity className={`w-5 h-5 ${!isPrinterReady ? 'animate-pulse' : ''}`} /></div>
                <h2 className="font-black uppercase tracking-widest text-sm text-slate-300">Manual Jog & Capture</h2>
              </div>
              <div className="flex gap-4">
                {queueSize > 0 && <div className="flex items-center gap-2 text-[10px] font-bold text-cyan-400 uppercase bg-cyan-500/10 px-3 py-1 rounded-full border border-cyan-500/20"><FastForward className="w-3 h-3" /> Queue: {queueSize}</div>}
                {!isPrinterReady && isConnected && <div className="flex items-center gap-2 text-[10px] font-bold text-amber-500 uppercase bg-amber-500/10 px-3 py-1 rounded-full border border-amber-500/20"><Loader2 className="w-3 h-3 animate-spin" /> Moving</div>}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
              <div className="flex flex-col items-center gap-8">
                <div className="relative w-48 h-48">
                  <button onClick={() => jog('Y', stepSize)} disabled={!isConnected || queueSize > 4} className="absolute top-0 left-1/2 -translate-x-1/2 w-16 h-16 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl flex items-center justify-center border border-slate-700 shadow-xl active:scale-90 transition-all"><ArrowUp className="text-cyan-400" /></button>
                  <button onClick={() => jog('Y', -stepSize)} disabled={!isConnected || queueSize > 4} className="absolute bottom-0 left-1/2 -translate-x-1/2 w-16 h-16 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl flex items-center justify-center border border-slate-700 shadow-xl active:scale-90 transition-all"><ArrowDown className="text-cyan-400" /></button>
                  <button onClick={() => jog('X', -stepSize)} disabled={!isConnected || queueSize > 4} className="absolute left-0 top-1/2 -translate-y-1/2 w-16 h-16 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl flex items-center justify-center border border-slate-700 shadow-xl active:scale-90 transition-all"><ArrowLeft className="text-cyan-400" /></button>
                  <button onClick={() => jog('X', stepSize)} disabled={!isConnected || queueSize > 4} className="absolute right-0 top-1/2 -translate-y-1/2 w-16 h-16 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl flex items-center justify-center border border-slate-700 shadow-xl active:scale-90 transition-all"><ArrowRight className="text-cyan-400" /></button>
                  <div className="absolute inset-0 m-auto w-12 h-12 bg-slate-950 border border-slate-800 rounded-full flex items-center justify-center shadow-inner"><div className={`w-3 h-3 rounded-full ${isConnected ? (isPrinterReady ? 'bg-emerald-500 shadow-[0_0_10px_#10b981]' : 'bg-amber-500 animate-pulse') : 'bg-slate-800'}`} /></div>
                </div>
                <div className="flex gap-4 w-full">
                  <button onClick={() => jog('Z', stepSize)} disabled={!isConnected || queueSize > 4} className="flex-1 flex items-center justify-center gap-3 py-4 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl border border-slate-700 shadow-xl transition-all active:scale-90"><MoveUp className="w-5 h-5 text-amber-500" /><span className="text-xs font-black text-slate-300">+Z</span></button>
                  <button onClick={() => jog('Z', -stepSize)} disabled={!isConnected || queueSize > 4} className="flex-1 flex items-center justify-center gap-3 py-4 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl border border-slate-700 shadow-xl transition-all active:scale-90"><MoveDown className="w-5 h-5 text-amber-500" /><span className="text-xs font-black text-slate-300">-Z</span></button>
                </div>
              </div>

              <div className="space-y-6">
                <div className="space-y-3">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Step Size (mm)</label>
                  <div className="grid grid-cols-4 gap-2 bg-slate-950 p-1.5 rounded-2xl border border-slate-800 mb-2">
                    {[0.1, 1, 10, 50].map(s => (
                      <button key={s} onClick={() => setStepSize(s)} className={`py-2 text-[10px] font-black rounded-lg transition-all ${stepSize === s ? 'bg-cyan-500 text-slate-900 shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}>{s}</button>
                    ))}
                  </div>
                  <div className="relative group">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-cyan-400 transition-colors">
                      <Target className="w-4 h-4" />
                    </div>
                    <input 
                      type="number" 
                      placeholder="Custom Step" 
                      value={stepSize}
                      step="0.01"
                      onChange={(e) => setStepSize(parseFloat(e.target.value) || 0)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-12 pr-12 py-4 text-xs font-bold text-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 transition-all"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] font-black text-slate-600 uppercase">mm</span>
                  </div>
                </div>

                <div className="space-y-3">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Feedrate</label>
                  <input type="range" min="300" max="8000" step="100" value={feedrate} onChange={(e) => setFeedrate(parseInt(e.target.value))} className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500" />
                  <div className="flex justify-between text-[10px] font-mono text-cyan-400/60 font-bold"><span>300</span><span>{feedrate} mm/min</span><span>8000</span></div>
                </div>

                <div className="pt-4">
                  <button 
                    onClick={onCapture}
                    className="w-full py-6 bg-gradient-to-br from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 text-slate-900 rounded-[2rem] font-black text-lg shadow-2xl shadow-orange-500/20 active:scale-95 transition-all flex items-center justify-center gap-4 group"
                  >
                    <Camera className="w-8 h-8 group-hover:rotate-12 transition-transform" />
                    CAPTURE IMAGE
                  </button>
                  <p className="text-[9px] text-slate-500 text-center mt-3 uppercase tracking-widest font-bold">Shortcut: <span className="text-slate-400">Ctrl + Enter</span></p>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-slate-900/30 border border-slate-800 rounded-3xl p-6 flex gap-6 items-center">
            <div className="p-3 bg-slate-800 rounded-2xl text-slate-400"><Keyboard className="w-6 h-6" /></div>
            <div>
              <h4 className="text-xs font-black text-white uppercase tracking-widest mb-1">Keyboard Shortcuts</h4>
              <p className="text-[10px] text-slate-500 leading-relaxed">Arrows for XY • PageUp/Down for Z • Ctrl+Enter to Capture</p>
            </div>
          </div>
        </div>

        {/* Right Column: Manual Gallery */}
        <div className="lg:col-span-5 flex flex-col space-y-6">
          <div className="flex-1 bg-slate-900/50 border border-slate-800 rounded-[2.5rem] p-8 flex flex-col shadow-xl backdrop-blur-sm max-h-[700px]">
            <div className="flex items-center justify-between mb-6 shrink-0">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-cyan-500/10 rounded-lg text-cyan-500"><ImageIcon className="w-5 h-5" /></div>
                <h2 className="font-black uppercase tracking-widest text-sm text-slate-300">Manual Captures</h2>
              </div>
              <div className="flex gap-2">
                {manualCaptures.length > 0 && (
                  <>
                    <button 
                      onClick={() => {
                        manualCaptures.forEach(img => downloadImage(img));
                      }}
                      className="p-2 bg-cyan-500/10 hover:bg-cyan-500 text-cyan-400 hover:text-slate-900 rounded-xl transition-all border border-cyan-500/20"
                      title="Download All"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => {
                        if (confirm("Clear all manual captures?")) setManualCaptures([]);
                      }}
                      className="p-2 bg-rose-500/10 hover:bg-rose-500 text-rose-500 hover:text-white rounded-xl transition-all border border-rose-500/20"
                      title="Clear All"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </>
                )}
                <span className="px-3 py-1 bg-slate-800 rounded-full text-[10px] font-black text-cyan-400 border border-slate-700 flex items-center">{manualCaptures.length}</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-4">
              {manualCaptures.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-700 space-y-4 opacity-50">
                  <Camera className="w-16 h-16 stroke-[1]" />
                  <p className="text-[10px] font-black uppercase tracking-[0.2em]">No manual captures yet</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  {manualCaptures.map(img => (
                    <div key={img.id} className="group relative aspect-square bg-black rounded-2xl overflow-hidden border border-slate-800 hover:border-amber-500/50 transition-all">
                      <img src={img.dataUrl} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" alt={img.name} />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-4">
                        <p className="text-[9px] font-black text-white mb-3 truncate">{new Date(img.timestamp).toLocaleTimeString()}</p>
                        <div className="flex gap-2">
                          <button 
                            onClick={() => downloadImage(img)}
                            className="flex-1 py-2 bg-white hover:bg-cyan-400 text-slate-900 rounded-xl text-[9px] font-black uppercase transition-colors"
                          >
                            <Download className="w-3 h-3 inline mr-1" /> Save
                          </button>
                          <button 
                            onClick={() => handleDelete(img.id)}
                            className="p-2 bg-rose-500/20 hover:bg-rose-500 text-rose-500 hover:text-white rounded-xl transition-all"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ManualCapture;
