
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
  Download,
  Sparkles
} from 'lucide-react';
import { StackResult } from '../types';

interface Props {
  onSendCommand: (cmd: string) => Promise<void>;
  isConnected: boolean;
  isPrinterReady: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  queueSize: number;
  stackedResults: Record<string, StackResult>;
}

const JogController: React.FC<Props> = ({ 
  onSendCommand, 
  isConnected, 
  isPrinterReady, 
  onConnect, 
  onDisconnect, 
  queueSize,
  stackedResults
}) => {
  const [stepSize, setStepSize] = useState<number>(10);
  const [feedrate, setFeedrate] = useState<number>(3000);
  const lastCommandTime = useRef<number>(0);

  const jog = useCallback(async (axis: 'X' | 'Y' | 'Z', distance: number) => {
    if (!isConnected) return;
    
    // Throttle UI commands
    const now = Date.now();
    if (now - lastCommandTime.current < 80) return; 
    lastCommandTime.current = now;

    const f = axis === 'Z' ? 600 : feedrate;
    await onSendCommand(`G91\nG1 ${axis}${distance} F${f}\nG90`);
  }, [isConnected, onSendCommand, feedrate]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isConnected || document.activeElement?.tagName === 'INPUT') return;
      if (queueSize > 2) return; 

      switch (e.key) {
        // Corrected Y mapping as requested
        case 'ArrowUp': jog('Y', stepSize); break; 
        case 'ArrowDown': jog('Y', -stepSize); break;
        case 'ArrowLeft': jog('X', -stepSize); break;
        case 'ArrowRight': jog('X', stepSize); break;
        case 'PageUp': jog('Z', stepSize); break;
        case 'PageDown': jog('Z', -stepSize); break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isConnected, queueSize, jog, stepSize]);

  const downloadStack = (label: string, dataUrl: string) => {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `${label}.jpg`;
    link.click();
  };

  const finishedStacks = (Object.values(stackedResults) as StackResult[]).filter(s => s.dataUrl && !s.isProcessing);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="bg-slate-900/50 border border-slate-800 rounded-3xl p-8 shadow-xl backdrop-blur-sm">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-500/10 rounded-lg text-amber-500"><Activity className={`w-5 h-5 ${!isPrinterReady ? 'animate-pulse' : ''}`} /></div>
            <h2 className="font-black uppercase tracking-widest text-sm text-slate-300">Motion Control</h2>
          </div>
          <div className="flex gap-4">
            {queueSize > 0 && <div className="flex items-center gap-2 text-[10px] font-bold text-cyan-400 uppercase bg-cyan-500/10 px-3 py-1 rounded-full border border-cyan-500/20"><FastForward className="w-3 h-3" /> Queue: {queueSize}</div>}
            {!isPrinterReady && isConnected && <div className="flex items-center gap-2 text-[10px] font-bold text-amber-500 uppercase bg-amber-500/10 px-3 py-1 rounded-full border border-amber-500/20"><Loader2 className="w-3 h-3 animate-spin" /> Moving</div>}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
          <div className="lg:col-span-3 space-y-3">
            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1 block">Utilities</label>
            <button onClick={() => onSendCommand("G28")} disabled={!isConnected} className="w-full flex items-center justify-between px-5 py-4 bg-slate-800 hover:bg-slate-700 disabled:opacity-20 rounded-2xl border border-slate-700 transition-all text-xs font-bold text-slate-300">Home All <Home className="w-4 h-4 text-cyan-500" /></button>
            <button onClick={() => onSendCommand("G28 X Y")} disabled={!isConnected} className="w-full flex items-center justify-between px-5 py-4 bg-slate-800 hover:bg-slate-700 disabled:opacity-20 rounded-2xl border border-slate-700 transition-all text-xs font-bold text-slate-300">Home X/Y <Crosshair className="w-4 h-4 text-cyan-400" /></button>
            <button onClick={() => onSendCommand("G92 X0 Y0 Z10")} disabled={!isConnected} className="w-full flex items-center justify-between px-5 py-4 bg-emerald-500/10 hover:bg-emerald-500/20 disabled:opacity-20 rounded-2xl border border-emerald-500/20 transition-all text-xs font-bold text-emerald-400">Set Zero Here <div className="w-2 h-2 rounded-full bg-emerald-500" /></button>
            <button onClick={() => onSendCommand("M18")} disabled={!isConnected} className="w-full flex items-center justify-between px-5 py-4 bg-slate-800/30 hover:bg-rose-500/10 disabled:opacity-20 rounded-2xl border border-slate-800 transition-all text-xs font-bold text-slate-500 hover:text-rose-400">Unlock Motors <Unlock className="w-4 h-4" /></button>
          </div>

          <div className="lg:col-span-5 flex flex-col items-center gap-8">
            <div className="relative w-48 h-48">
              {/* Corrected Signage for Y movement */}
              <button onClick={() => jog('Y', stepSize)} disabled={!isConnected || queueSize > 4} className="absolute top-0 left-1/2 -translate-x-1/2 w-16 h-16 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl flex items-center justify-center border border-slate-700 shadow-xl active:scale-90 transition-all"><ArrowUp className="text-cyan-400" /></button>
              <button onClick={() => jog('Y', -stepSize)} disabled={!isConnected || queueSize > 4} className="absolute bottom-0 left-1/2 -translate-x-1/2 w-16 h-16 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl flex items-center justify-center border border-slate-700 shadow-xl active:scale-90 transition-all"><ArrowDown className="text-cyan-400" /></button>
              <button onClick={() => jog('X', -stepSize)} disabled={!isConnected || queueSize > 4} className="absolute left-0 top-1/2 -translate-y-1/2 w-16 h-16 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl flex items-center justify-center border border-slate-700 shadow-xl active:scale-90 transition-all"><ArrowLeft className="text-cyan-400" /></button>
              <button onClick={() => jog('X', stepSize)} disabled={!isConnected || queueSize > 4} className="absolute right-0 top-1/2 -translate-y-1/2 w-16 h-16 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl flex items-center justify-center border border-slate-700 shadow-xl active:scale-90 transition-all"><ArrowRight className="text-cyan-400" /></button>
              <div className="absolute inset-0 m-auto w-12 h-12 bg-slate-950 border border-slate-800 rounded-full flex items-center justify-center shadow-inner"><div className={`w-3 h-3 rounded-full ${isConnected ? (isPrinterReady ? 'bg-emerald-500 shadow-[0_0_10px_#10b981]' : 'bg-amber-500 animate-pulse') : 'bg-slate-800'}`} /></div>
            </div>
            <div className="flex gap-6">
              <button onClick={() => jog('Z', stepSize)} disabled={!isConnected || queueSize > 4} className="flex items-center gap-4 px-8 py-4 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl border border-slate-700 shadow-xl transition-all active:scale-90"><MoveUp className="w-5 h-5 text-amber-500" /><span className="text-xs font-black text-slate-300">+Z</span></button>
              <button onClick={() => jog('Z', -stepSize)} disabled={!isConnected || queueSize > 4} className="flex items-center gap-4 px-8 py-4 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl border border-slate-700 shadow-xl transition-all active:scale-90"><MoveDown className="w-5 h-5 text-amber-500" /><span className="text-xs font-black text-slate-300">-Z</span></button>
            </div>
          </div>

          <div className="lg:col-span-4 space-y-6">
            <div className="space-y-3">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Step Magnitude (mm)</label>
              <div className="grid grid-cols-4 gap-2 bg-slate-950 p-1.5 rounded-2xl border border-slate-800 mb-2">
                {[0.1, 1, 10, 50].map(s => (
                  <button key={s} onClick={() => setStepSize(s)} className={`py-3 text-xs font-black rounded-xl transition-all ${stepSize === s ? 'bg-cyan-500 text-slate-900 shadow-lg shadow-cyan-500/20' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-900'}`}>{s}</button>
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
            <div className="space-y-4 pt-2">
              <div className="flex justify-between items-center"><label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Feedrate Speed</label><span className="text-xs font-mono text-cyan-400 font-bold">{feedrate} mm/min</span></div>
              <input type="range" min="300" max="8000" step="100" value={feedrate} onChange={(e) => setFeedrate(parseInt(e.target.value))} className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-500" />
            </div>
            <div className="p-5 bg-slate-950/50 rounded-2xl border border-slate-800 flex gap-4">
               <Keyboard className="w-5 h-5 text-slate-600 shrink-0" />
               <p className="text-[10px] text-slate-500 leading-relaxed font-medium">Use <span className="text-slate-300">Arrow Keys</span> for X/Y and <span className="text-slate-300">PageUp/PageDown</span> for Z movement.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Optimized Stacks Section for Quick Download */}
      {finishedStacks.length > 0 && (
        <div className="bg-slate-900/40 border border-slate-800 rounded-[2rem] p-8 animate-in fade-in zoom-in duration-500">
           <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                 <div className="p-2 bg-amber-500/10 rounded-lg text-amber-500"><Sparkles className="w-5 h-5" /></div>
                 <h2 className="font-black uppercase tracking-widest text-sm text-slate-300">Optimized Stacks</h2>
              </div>
           </div>
           <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
              {finishedStacks.map(stack => (
                <div key={stack.label} className="group relative bg-slate-800/50 rounded-2xl overflow-hidden border border-slate-700 hover:border-amber-500/40 transition-all aspect-square">
                   <img src={stack.dataUrl} className="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity" alt={stack.label} />
                   <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent flex flex-col justify-end p-3 opacity-0 group-hover:opacity-100 transition-opacity">
                      <p className="text-[10px] font-black text-amber-400 mb-1">{stack.label}.jpg</p>
                      <button 
                        onClick={() => downloadStack(stack.label, stack.dataUrl)}
                        className="w-full py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-900 rounded-lg text-[9px] font-black uppercase flex items-center justify-center gap-1.5 transition-all"
                      >
                         <Download className="w-3 h-3" /> Download
                      </button>
                   </div>
                   <div className="absolute top-2 left-2 px-1.5 py-0.5 bg-black/60 rounded text-[8px] font-black text-white border border-white/10">{stack.label}</div>
                </div>
              ))}
           </div>
        </div>
      )}
    </div>
  );
};

export default JogController;
