
import React, { useState, useMemo } from 'react';
import { 
  Ruler, 
  ArrowUp, 
  ArrowDown, 
  CheckCircle2, 
  AlertTriangle, 
  ChevronRight, 
  ChevronLeft,
  Home,
  Target,
  RefreshCw,
  Zap
} from 'lucide-react';
import { ScanSettings } from '../types';
import { getInterpolatedData } from '../services/gcodeService';

interface Props {
  settings: ScanSettings;
  setSettings: React.Dispatch<React.SetStateAction<ScanSettings>>;
  currentZ: number;
  onJog: (axis: 'X' | 'Y' | 'Z', distance: number, feedrate: number) => Promise<void>;
  onHome: () => Promise<void>;
  isConnected: boolean;
  isPrinterReady: boolean;
  onProceed: () => void;
  onReturn: () => void;
}

const MagnificationVerifier: React.FC<Props> = ({
  settings,
  setSettings,
  currentZ,
  onJog,
  onHome,
  isConnected,
  isPrinterReady,
  onProceed,
  onReturn
}) => {
  const [z1, setZ1] = useState<number | null>(null);
  const [z2, setZ2] = useState<number | null>(null);
  const [stepSize, setStepSize] = useState(1);

  const specs = useMemo(() => getInterpolatedData(settings.magnification), [settings.magnification]);
  const workingDistance = specs.wd;

  const sampleHeight = useMemo(() => {
    if (z1 === null || z2 === null) return null;
    return Math.abs(z2 - z1);
  }, [z1, z2]);

  const isPossible = useMemo(() => {
    if (sampleHeight === null) return null;
    return sampleHeight <= workingDistance;
  }, [sampleHeight, workingDistance]);

  const recommendedMaxMag = useMemo(() => {
    if (sampleHeight === null || sampleHeight === 0) return null;
    return settings.magnification * (workingDistance / sampleHeight);
  }, [sampleHeight, workingDistance, settings.magnification]);

  const handleMarkZ1 = () => setZ1(currentZ);
  const handleMarkZ2 = () => setZ2(currentZ);
  const handleReset = () => {
    setZ1(null);
    setZ2(null);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="bg-slate-900/50 border border-slate-800 rounded-[2.5rem] p-8 shadow-2xl backdrop-blur-md">
        <div className="flex items-center justify-between mb-10">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-cyan-500 rounded-2xl shadow-xl shadow-cyan-500/20">
              <Ruler className="w-6 h-6 text-slate-900" />
            </div>
            <div>
              <h2 className="text-xl font-black text-white tracking-tight">Magnification Verification</h2>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1">Validate optical clearance for 3D scanning</p>
            </div>
          </div>
          <button 
            onClick={onReturn}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-slate-400 hover:text-white transition-colors"
          >
            <ChevronLeft className="w-4 h-4" /> Back to Setup
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          {/* Step 1: Calibration Controls */}
          <div className="space-y-8">
            <div className="space-y-6">
              <div className="flex items-center gap-3 text-cyan-400">
                <div className="w-6 h-6 rounded-full border-2 border-current flex items-center justify-center text-[10px] font-black">1</div>
                <h3 className="text-sm font-black uppercase tracking-widest">Measure Sample Height</h3>
              </div>

              <div className="bg-slate-950/50 border border-slate-800 rounded-3xl p-6 space-y-6">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Current Z Position</span>
                  <span className="text-xl font-mono font-black text-white">{currentZ.toFixed(3)} <span className="text-[10px] text-slate-600">mm</span></span>
                </div>

                <div className="flex gap-4">
                  <button 
                    onClick={() => onJog('Z', stepSize, 3000)}
                    disabled={!isConnected || !isPrinterReady}
                    className="flex-1 flex flex-col items-center gap-2 py-4 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl border border-slate-700 transition-all active:scale-95"
                  >
                    <ArrowUp className="w-5 h-5 text-amber-500" />
                    <span className="text-[10px] font-black text-slate-300 uppercase">Jog Up</span>
                  </button>
                  <button 
                    onClick={() => onJog('Z', -stepSize, 3000)}
                    disabled={!isConnected || !isPrinterReady}
                    className="flex-1 flex flex-col items-center gap-2 py-4 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-2xl border border-slate-700 transition-all active:scale-95"
                  >
                    <ArrowDown className="w-5 h-5 text-amber-500" />
                    <span className="text-[10px] font-black text-slate-300 uppercase">Jog Down</span>
                  </button>
                </div>

                <div className="grid grid-cols-4 gap-2">
                  {[0.1, 1, 5, 10].map(s => (
                    <button 
                      key={s} 
                      onClick={() => setStepSize(s)}
                      className={`py-2 text-[10px] font-black rounded-lg transition-all ${stepSize === s ? 'bg-cyan-500 text-slate-900 shadow-lg' : 'text-slate-500 hover:text-slate-300 bg-slate-900'}`}
                    >
                      {s}
                    </button>
                  ))}
                </div>

                <div className="pt-4 grid grid-cols-2 gap-4">
                  <button 
                    onClick={handleMarkZ1}
                    className={`py-4 rounded-2xl border-2 font-black text-xs transition-all ${z1 !== null ? 'bg-emerald-500/10 border-emerald-500 text-emerald-400' : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-600'}`}
                  >
                    {z1 !== null ? `Low: ${z1.toFixed(2)}` : 'Mark Low Point'}
                  </button>
                  <button 
                    onClick={handleMarkZ2}
                    className={`py-4 rounded-2xl border-2 font-black text-xs transition-all ${z2 !== null ? 'bg-rose-500/10 border-rose-500 text-rose-400' : 'bg-slate-900 border-slate-800 text-slate-400 hover:border-slate-600'}`}
                  >
                    {z2 !== null ? `High: ${z2.toFixed(2)}` : 'Mark High Point'}
                  </button>
                </div>

                <button 
                  onClick={onHome}
                  disabled={!isConnected || !isPrinterReady}
                  className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-slate-500 hover:text-slate-300 rounded-xl border border-slate-800 text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2"
                >
                  <Home className="w-3 h-3" /> Reset Z Home
                </button>
              </div>
            </div>
          </div>

          {/* Step 2: Analysis Results */}
          <div className="space-y-8">
            <div className="flex items-center gap-3 text-amber-400">
              <div className="w-6 h-6 rounded-full border-2 border-current flex items-center justify-center text-[10px] font-black">2</div>
              <h3 className="text-sm font-black uppercase tracking-widest">Validation Results</h3>
            </div>

            <div className="bg-slate-950/50 border border-slate-800 rounded-3xl p-8 space-y-8 min-h-[400px] flex flex-col">
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-1">
                  <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Current Mag</p>
                  <p className="text-2xl font-black text-white">{settings.magnification}x</p>
                </div>
                <div className="space-y-1">
                  <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Working Dist</p>
                  <p className="text-2xl font-black text-cyan-400">{workingDistance.toFixed(2)} <span className="text-xs">mm</span></p>
                </div>
              </div>

              <div className="p-6 bg-slate-900/50 rounded-2xl border border-slate-800 flex items-center justify-between">
                <div>
                  <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Sample Height (ΔZ)</p>
                  <p className="text-3xl font-black text-white">
                    {sampleHeight !== null ? sampleHeight.toFixed(2) : '--.--'} 
                    <span className="text-sm ml-1 text-slate-600">mm</span>
                  </p>
                </div>
                {sampleHeight !== null && (
                  <button onClick={handleReset} className="p-2 text-slate-600 hover:text-rose-500 transition-colors">
                    <RefreshCw className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="flex-1 flex flex-col justify-center">
                {sampleHeight === null ? (
                  <div className="text-center space-y-4 opacity-30">
                    <Target className="w-12 h-12 mx-auto text-slate-600" />
                    <p className="text-[10px] font-black uppercase tracking-widest">Waiting for measurements...</p>
                  </div>
                ) : isPossible ? (
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-6 space-y-4 animate-in zoom-in duration-300">
                    <div className="flex items-center gap-3 text-emerald-400">
                      <CheckCircle2 className="w-6 h-6" />
                      <span className="text-sm font-black uppercase tracking-widest">Scan Possible</span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      The sample height variation ({sampleHeight.toFixed(2)}mm) is within the working distance ({workingDistance.toFixed(2)}mm) of the current objective.
                    </p>
                    <button 
                      onClick={onProceed}
                      className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-900 rounded-xl font-black text-xs transition-all flex items-center justify-center gap-2"
                    >
                      Proceed to Scan <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="bg-rose-500/10 border border-rose-500/20 rounded-2xl p-6 space-y-4 animate-in zoom-in duration-300">
                    <div className="flex items-center gap-3 text-rose-400">
                      <AlertTriangle className="w-6 h-6" />
                      <span className="text-sm font-black uppercase tracking-widest">Mag Too High</span>
                    </div>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Sample variation exceeds working distance. Collision risk detected.
                    </p>
                    <div className="pt-2 space-y-3">
                      <div className="flex justify-between items-center">
                        <span className="text-[10px] font-bold text-slate-500 uppercase">Recommended Max Mag</span>
                        <span className="text-sm font-black text-rose-400">{recommendedMaxMag?.toFixed(1)}x</span>
                      </div>
                      <button 
                        onClick={() => {
                          if (recommendedMaxMag) {
                            setSettings(s => ({ ...s, magnification: Math.floor(recommendedMaxMag) }));
                          }
                        }}
                        className="w-full py-3 bg-rose-500 hover:bg-rose-400 text-white rounded-xl font-black text-xs transition-all flex items-center justify-center gap-2"
                      >
                        Apply Recommended Mag <Zap className="w-4 h-4 fill-current" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-slate-900/30 border border-slate-800 rounded-3xl p-6 flex gap-6 items-center">
        <div className="p-3 bg-slate-800 rounded-2xl text-slate-400"><Target className="w-6 h-6" /></div>
        <div className="flex-1">
          <h4 className="text-xs font-black text-white uppercase tracking-widest mb-1">Calibration Tip</h4>
          <p className="text-[10px] text-slate-500 leading-relaxed">
            Ensure you are focused at both the lowest and highest points of your sample to get an accurate height measurement.
          </p>
        </div>
      </div>
    </div>
  );
};

export default MagnificationVerifier;
