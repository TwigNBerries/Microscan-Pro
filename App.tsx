
import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { ScanSettings, GridDimensions, CapturedImage, StackResult, DepthResult, DepthMethod } from './types';
import { calculateGrid, generateGCode, getInterpolatedData } from './services/gcodeService';
import { performFocusStack } from './services/stackingService';
import NumberInput from './components/NumberInput';
import Visualizer from './components/Visualizer';
import JogController from './components/JogController';
import StitchingView from './components/StitchingView';
import StackingLab from './components/StackingLab';
import DepthLab from './components/DepthLab';
import ManualCapture from './components/ManualCapture';
import { computeDepthMap } from './services/depthService';
import JSZip from 'jszip';
import { 
  Settings, 
  Microscope,
  Activity,
  Zap,
  LayoutGrid,
  Play,
  Square,
  Camera,
  Image as ImageIcon,
  Trash2,
  ChevronDown,
  RefreshCw,
  Power,
  Layers,
  FolderDown,
  FileArchive,
  Ruler,
  Combine,
  Sparkles,
  Timer,
  Maximize2,
  Loader2,
  Search,
  HelpCircle,
  Map
} from 'lucide-react';

type QueueItem = 
  | { type: 'GCODE'; value: string }
  | { type: 'CAPTURE'; label: string; r: number; c: number; z: number };

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'config' | 'jog' | 'manual' | 'gallery' | 'stitching' | 'stacking' | 'depth'>('config');
  const [showCamera, setShowCamera] = useState(true);
  
  const [settings, setSettings] = useState<ScanSettings>({
    sampleWidth: 1.0,
    sampleHeight: 1.0,
    units: 'in',
    magnification: 50,
    overlapPercent: 20,
    zStackCount: 3, 
    zStepMicrons: 100,
    stabilizeXYMs: 500,
    settleZMs: 250,
    gcodeFlavor: 'marlin',
    depthDownscale: true,
    xyScaleFactor: 1.0
  });

  const [capturedImages, setCapturedImages] = useState<CapturedImage[]>([]);
  const [manualCaptures, setManualCaptures] = useState<CapturedImage[]>([]);
  const [stackedResults, setStackedResults] = useState<Record<string, StackResult>>({});
  const [depthResults, setDepthResults] = useState<Record<string, DepthResult>>({});
  const [isExporting, setIsExporting] = useState(false);

  const portRef = useRef<any>(null);
  const writerRef = useRef<any>(null);
  const readerRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const masterQueueRef = useRef<QueueItem[]>([]);
  const lineBufferRef = useRef<string>("");
  const totalQueueSizeRef = useRef<number>(0);

  const [isConnected, setIsConnected] = useState(false);
  const [isPrinterReady, setIsPrinterReady] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [currentTaskLabel, setCurrentTaskLabel] = useState<string>("");
  const [consoleLogs, setConsoleLogs] = useState<string[]>([]);
  const [remainingItems, setRemainingItems] = useState(0);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);

  // Jog persistence
  const [jogStep, setJogStep] = useState<number>(10);
  const [jogFeedrate, setJogFeedrate] = useState<number>(3000);

  const grid: GridDimensions = useMemo(() => calculateGrid(settings), [settings]);
  const specs = useMemo(() => getInterpolatedData(settings.magnification), [settings.magnification]);
  
  const [videoDimensions, setVideoDimensions] = useState({ width: 3840, height: 2160 });

  const pixelResolution = useMemo(() => {
    const res = (specs.fovX / videoDimensions.width) * 1000; // µm per pixel
    console.log(`DEPTH: Calculated pixel resolution: ${res.toFixed(4)} um/px (FOV: ${specs.fovX}mm, Width: ${videoDimensions.width}px)`);
    return res;
  }, [specs.fovX, videoDimensions.width]);

  const scaleBarWidthPx = useMemo(() => {
    const targetMm = specs.fovX > 10 ? 5 : (specs.fovX > 2 ? 1 : 0.5);
    const pxPerMm = videoDimensions.width / specs.fovX;
    return { px: pxPerMm * targetMm, label: `${targetMm} mm` };
  }, [specs.fovX, videoDimensions.width]);

  const groupedCapturedImages = useMemo(() => {
    const groups: Record<string, CapturedImage[]> = {};
    capturedImages.forEach(img => {
      if (!groups[img.label]) groups[img.label] = [];
      groups[img.label].push(img);
    });
    Object.keys(groups).forEach(label => {
      groups[label].sort((a, b) => a.gridPos.z - b.gridPos.z);
    });
    return groups;
  }, [capturedImages]);

  const scanProgress = useMemo(() => {
    if (!isScanning || totalQueueSizeRef.current === 0) return 0;
    const completed = totalQueueSizeRef.current - remainingItems;
    return Math.round((completed / totalQueueSizeRef.current) * 100);
  }, [isScanning, remainingItems]);

  const handleClearAllData = useCallback(() => {
    if (confirm("DANGER: This will permanently delete all captured images, manual captures, stacked masters, and reset the stitching lab. Continue?")) {
      setCapturedImages([]);
      setManualCaptures([]);
      setStackedResults({});
      setDepthResults({});
      addLog("SYSTEM: Laboratory cleared. Memory reset.");
    }
  }, []);

  const handleClearDepth = useCallback((label: string) => {
    setDepthResults(prev => {
      const next = { ...prev };
      delete next[label];
      return next;
    });
    addLog(`DEPTH: Cleared analysis for ${label}. Ready for recalculation.`);
  }, []);

  useEffect(() => {
    (Object.entries(groupedCapturedImages) as [string, CapturedImage[]][]).forEach(([label, images]) => {
      if (images.length === settings.zStackCount) {
        if (!stackedResults[label]) {
          handleTriggerStack(label, images);
        }
      }
    });
  }, [groupedCapturedImages, settings.zStackCount, stackedResults]);

  const handleTriggerStack = async (label: string, images: CapturedImage[]) => {
    setStackedResults(prev => ({
      ...prev,
      [label]: { label, dataUrl: "", isProcessing: true, sliceCount: images.length }
    }));

    addLog(`STACKER: Merging Z-layers for ${label}...`);
    const result = await performFocusStack(images.map(img => img.dataUrl));
    
    setStackedResults(prev => ({
      ...prev,
      [label]: { ...prev[label], dataUrl: result, isProcessing: false }
    }));
  };

  const handleTriggerDepth = async (label: string, images: CapturedImage[], method: DepthMethod = 'laplacian') => {
    const minZ = Math.min(...images.map(img => img.gridPos.z));
    const maxZ = Math.max(...images.map(img => img.gridPos.z));

    setDepthResults(prev => ({
      ...prev,
      [label]: { label, dataUrl: "", depthValues: [], width: 0, height: 0, isProcessing: true, minZ, maxZ, method }
    }));

    addLog(`DEPTH: Estimating surface topography for ${label} using ${method}...`);
    try {
      const downscaleFactor = (settings.depthDownscale && videoDimensions.width > 2000) ? 2.0 : 1.0;
      const result = await computeDepthMap(
        images, 
        method, 
        downscaleFactor, 
        settings.zStepMicrons,
        pixelResolution
      );
      setDepthResults(prev => ({
        ...prev,
        [label]: { 
          ...prev[label], 
          dataUrl: result.dataUrl, 
          depthValues: result.depthValues,
          width: result.width,
          height: result.height,
          isProcessing: false 
        }
      }));
    } catch (err) {
      addLog(`DEPTH ERROR: ${err instanceof Error ? err.message : String(err)}`);
      setDepthResults(prev => {
        const next = { ...prev };
        delete next[label];
        return next;
      });
    }
  };

  const addLog = useCallback((msg: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setConsoleLogs(prev => [`[${timestamp}] ${msg}`, ...prev].slice(0, 50));
  }, []);

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: { ideal: 3840 }, height: { ideal: 2160 } } 
      });
      
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      console.log("CAMERA: Track settings:", settings);
      if (settings.width && settings.height) {
        setVideoDimensions({ width: settings.width, height: settings.height });
        addLog(`CAMERA: Resolution detected: ${settings.width}x${settings.height}`);
      }

      setCameraStream(prev => {
        if (prev) prev.getTracks().forEach(track => track.stop());
        return stream;
      });

      addLog("CAMERA: High-Resolution sensor linked.");
    } catch (err) {
      addLog("CAMERA ERROR: Connection failed.");
    }
  }, [addLog]);

  useEffect(() => {
    startCamera();
    return () => { 
      if (cameraStream) cameraStream.getTracks().forEach(t => t.stop()); 
    };
  }, []);

  useEffect(() => {
    if (showCamera && videoRef.current && cameraStream) {
      const video = videoRef.current;
      if (video.srcObject !== cameraStream) {
        video.srcObject = cameraStream;
        video.play().catch(err => {
          if (err.name !== 'AbortError') {
            console.warn("Camera play interrupted or failed:", err);
          }
        });
      }
    }
  }, [cameraStream, showCamera]);

  const takeSnapshot = (label: string, r: number, c: number, z: number) => {
    const name = `${label}_${z}`;
    let dataUrl = "";
    if (videoRef.current && videoRef.current.readyState === 4 && canvasRef.current) {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        // Ensure videoDimensions is correct if it wasn't set by track settings
        if (video.videoWidth !== videoDimensions.width) {
          console.log(`CAMERA: Updating dimensions from video element: ${video.videoWidth}x${video.videoHeight}`);
          setVideoDimensions({ width: video.videoWidth, height: video.videoHeight });
        }

        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        }
    } else {
        if (canvasRef.current) {
            const canvas = canvasRef.current;
            canvas.width = 1280; canvas.height = 720;
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#1e293b'; ctx.fillRect(0,0,1280,720);
            ctx.fillStyle = '#334155'; ctx.font = 'bold 32px monospace';
            ctx.fillText(`SIMULATED CAPTURE: ${name}`, 80, 360);
            dataUrl = canvas.toDataURL();
        }
    }
    setCapturedImages(prev => [{ id: Math.random().toString(36).substr(2, 9), name, label, dataUrl, timestamp: Date.now(), gridPos: { r, c, z } }, ...prev]);
    return true;
  };

  const takeManualSnapshot = () => {
    let dataUrl = "";
    if (videoRef.current && videoRef.current.readyState === 4 && canvasRef.current) {
        const canvas = canvasRef.current;
        const video = videoRef.current;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        }
    } else {
        if (canvasRef.current) {
            const canvas = canvasRef.current;
            canvas.width = 1280; canvas.height = 720;
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#1e293b'; ctx.fillRect(0,0,1280,720);
            ctx.fillStyle = '#334155'; ctx.font = 'bold 32px monospace';
            ctx.fillText(`MANUAL CAPTURE: ${new Date().toLocaleTimeString()}`, 80, 360);
            dataUrl = canvas.toDataURL();
        }
    }
    
    if (dataUrl) {
      setManualCaptures(prev => [{ 
        id: Math.random().toString(36).substr(2, 9), 
        name: `Manual_${Date.now()}`, 
        label: 'MANUAL', 
        dataUrl, 
        timestamp: Date.now(), 
        gridPos: { r: 0, c: 0, z: 0 } 
      }, ...prev]);
      addLog("CAMERA: Manual capture saved.");
      return true;
    }
    return false;
  };

  const readFromSerial = async (port: any) => {
    const textDecoder = new TextDecoderStream();
    port.readable.pipeTo(textDecoder.writable);
    readerRef.current = textDecoder.readable.getReader();
    try {
      while (true) {
        const { value, done } = await readerRef.current.read();
        if (done) break;
        lineBufferRef.current += value;
        if (lineBufferRef.current.includes('\n')) {
          const lines = lineBufferRef.current.split('\n');
          lineBufferRef.current = lines.pop() || "";
          for (const line of lines) {
            const clean = line.trim().toLowerCase();
            if (clean.includes('ok')) setIsPrinterReady(true);
          }
        }
      }
    } catch (err) { setIsConnected(false); }
  };

  const processNextItem = useCallback(async () => {
    if (!isPrinterReady || masterQueueRef.current.length === 0 || !writerRef.current) {
      if (isScanning && masterQueueRef.current.length === 0) { 
        setIsScanning(false); 
        setCurrentTaskLabel("");
        addLog("SCANNER: Sequence Finalized."); 
      }
      return;
    }
    const item = masterQueueRef.current.shift();
    setRemainingItems(masterQueueRef.current.length);
    if (item?.type === 'GCODE') {
      setIsPrinterReady(false);
      setCurrentTaskLabel(item.value.startsWith('G1 X') ? "Relocating head..." : "Adjusting focus...");
      await writerRef.current.write(item.value + '\n');
    } else if (item?.type === 'CAPTURE') {
      setCurrentTaskLabel(`Capturing Tile ${item.label} (Z: ${item.z})`);
      takeSnapshot(item.label, item.r, item.c, item.z);
      // CAPTURE items are virtual, reset ready immediately
      setIsPrinterReady(true); 
    }
  }, [isPrinterReady, isScanning, addLog]);

  useEffect(() => { processNextItem(); }, [isPrinterReady, remainingItems, processNextItem]);

  const sendManualCommand = async (cmd: string) => {
    if (!isConnected || !writerRef.current) return;
    cmd.split('\n').filter(l => l.trim()).forEach(l => masterQueueRef.current.push({ type: 'GCODE', value: l }));
    setRemainingItems(masterQueueRef.current.length);
  };

  const handleStartScan = () => {
    if (!isConnected) return;
    const gcode = generateGCode(settings, grid);
    masterQueueRef.current = [];
    gcode.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed.includes('; APP_CAPTURE')) {
        const m = trimmed.match(/; APP_CAPTURE (\w+) (\d+) (\d+) (\d+)/);
        if (m) masterQueueRef.current.push({ type: 'CAPTURE', label: m[1], r: parseInt(m[2]), c: parseInt(m[3]), z: parseInt(m[4]) });
      } else if (trimmed && !trimmed.startsWith(';')) masterQueueRef.current.push({ type: 'GCODE', value: trimmed });
    });
    totalQueueSizeRef.current = masterQueueRef.current.length;
    setRemainingItems(masterQueueRef.current.length);
    setIsScanning(true);
  };

  const handleDownloadAllStructured = async () => {
    if (capturedImages.length === 0) return;
    setIsExporting(true);
    const zip = new JSZip();
    capturedImages.forEach(img => zip.file(`Stack_${img.label}/${img.name}.jpg`, img.dataUrl.split(',')[1], { base64: true }));
    const content = await zip.generateAsync({ type: "blob" });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content); link.download = `MicroScan_Project_${Date.now()}.zip`; link.click();
    setIsExporting(false);
  };

  return (
    <div className="min-h-screen p-4 md:p-8 flex flex-col items-center max-w-7xl mx-auto relative pb-32">
      <canvas ref={canvasRef} className="hidden" />

      {isScanning && (
        <div className="fixed top-0 left-0 w-full z-[100] animate-in slide-in-from-top duration-500">
           <div className="bg-slate-900/90 backdrop-blur-xl border-b border-cyan-500/20 px-8 py-4 shadow-2xl flex flex-col md:flex-row items-center gap-6">
              <div className="flex items-center gap-4 shrink-0">
                 <div className="p-2 bg-cyan-500 rounded-lg shadow-[0_0_15px_#06b6d4]">
                    <Activity className="w-5 h-5 text-slate-900 animate-pulse" />
                 </div>
                 <div className="flex flex-col">
                    <span className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-400">Live Mission Progress</span>
                    <span className="text-sm font-bold text-white flex items-center gap-2">
                       {currentTaskLabel || "Executing G-Code Sequence..."}
                    </span>
                 </div>
              </div>

              <div className="flex-1 w-full space-y-2">
                 <div className="flex justify-between items-end">
                    <span className="text-[10px] font-black text-slate-500 uppercase">Command Queue Status</span>
                    <span className="text-xs font-mono font-bold text-cyan-400">{scanProgress}% COMPLETE</span>
                 </div>
                 <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden border border-white/5 relative">
                    <div 
                      className="h-full bg-gradient-to-r from-cyan-600 to-cyan-400 transition-all duration-700 ease-out relative"
                      style={{ width: `${scanProgress}%` }}
                    >
                       <div className="absolute inset-0 bg-white/20 animate-pulse" />
                    </div>
                 </div>
              </div>

              <div className="flex items-center gap-6 shrink-0 border-l border-white/10 pl-6">
                 <div className="text-right">
                    <p className="text-[9px] font-black text-slate-500 uppercase">Tasks Remaining</p>
                    <p className="text-sm font-mono font-bold text-white">{remainingItems} / {totalQueueSizeRef.current}</p>
                 </div>
                 <button 
                   onClick={() => { masterQueueRef.current = []; setIsScanning(false); addLog("SCANNER: Aborted by user."); }}
                   className="flex items-center gap-2 px-4 py-2 bg-rose-500/10 hover:bg-rose-500 text-rose-500 hover:text-white border border-rose-500/20 rounded-xl font-bold text-xs transition-all"
                 >
                   <Square className="w-3 h-3 fill-current" /> Terminate
                 </button>
              </div>
           </div>
        </div>
      )}

      {/* Floating Microscope Feed */}
      <div className={`fixed bottom-6 right-6 z-50 transition-all duration-500 ease-in-out ${showCamera ? 'w-[320px] md:w-[600px]' : 'w-14 h-14'} overflow-hidden rounded-[2.5rem] border-4 border-slate-800 bg-black shadow-2xl ring-1 ring-white/10`}>
        {showCamera ? (
          <div className="relative aspect-video group">
             <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
             
             <div className="absolute bottom-6 left-6 flex flex-col items-start gap-1.5 pointer-events-none">
                <div className="flex items-baseline gap-2">
                   <div className="h-[2px] bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]" style={{ width: `${scaleBarWidthPx.px / 4}px` }} />
                   <span className="text-[10px] font-black text-white drop-shadow-lg uppercase tracking-widest">{scaleBarWidthPx.label}</span>
                </div>
                <div className="px-2 py-0.5 bg-black/60 backdrop-blur-md border border-white/20 rounded text-[9px] font-mono text-cyan-400">
                   FOV: {specs.fovX.toFixed(2)}mm
                </div>
             </div>

             <div className="absolute top-6 left-6 pointer-events-none">
                <div className="bg-black/40 backdrop-blur-md border border-white/10 p-3 rounded-2xl flex items-center gap-3">
                   <div className="w-8 h-8 rounded-full bg-cyan-500/20 flex items-center justify-center text-cyan-400">
                      <Search className="w-4 h-4" />
                   </div>
                   <div>
                      <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Live Optical Power</p>
                      <p className="text-xl font-black text-white leading-none">{settings.magnification}<span className="text-cyan-500 ml-0.5">X</span></p>
                   </div>
                </div>
             </div>

             <div className="absolute top-6 right-6 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={startCamera} className="p-3 bg-black/60 rounded-full text-white hover:bg-cyan-500 hover:text-slate-900 transition-all backdrop-blur-md border border-white/10"><RefreshCw className="w-4 h-4" /></button>
                <button onClick={() => setShowCamera(false)} className="p-3 bg-black/60 rounded-full text-white hover:bg-black transition-colors backdrop-blur-md border border-white/10"><ChevronDown className="w-4 h-4" /></button>
             </div>
          </div>
        ) : (
          <button onClick={() => setShowCamera(true)} className="w-full h-full flex items-center justify-center bg-cyan-500 text-slate-900 shadow-lg hover:scale-110 transition-transform"><Camera className="w-6 h-6" /></button>
        )}
      </div>

      <header className="w-full flex flex-col md:flex-row items-center justify-between gap-6 mb-10 pt-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-cyan-500 rounded-2xl shadow-xl shadow-cyan-500/20"><Microscope className="w-7 h-7 text-slate-900" /></div>
          <div><h1 className="text-2xl font-black text-white tracking-tight">MicroScan Pro</h1><div className="flex items-center gap-2 mt-1"><span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-700'}`} /><span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{isConnected ? 'Hardware Linked' : 'System Offline'}</span></div></div>
        </div>

          <nav className="flex p-1.5 bg-slate-900/80 rounded-2xl border border-slate-800 backdrop-blur-md">
          {[
            { id: 'config', label: 'Setup', icon: LayoutGrid },
            { id: 'jog', label: 'Jog', icon: Activity },
            { id: 'manual', label: 'Manual', icon: Camera },
            { id: 'stacking', label: 'Stack', icon: Sparkles },
            { id: 'depth', label: 'Depth', icon: Map },
            { id: 'stitching', label: 'Stitch', icon: Combine },
            { id: 'gallery', label: 'Gallery', icon: ImageIcon }
          ].map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id as any)} className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold transition-all ${activeTab === tab.id ? 'bg-slate-800 text-cyan-400 shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}>
              <tab.icon className="w-4 h-4" /> {tab.label}
              {tab.id === 'gallery' && capturedImages.length > 0 && <span className="ml-1 px-1.5 py-0.5 bg-cyan-500 text-slate-900 text-[8px] rounded-full">{capturedImages.length}</span>}
              {tab.id === 'manual' && manualCaptures.length > 0 && <span className="ml-1 px-1.5 py-0.5 bg-amber-500 text-slate-900 text-[8px] rounded-full">{manualCaptures.length}</span>}
            </button>
          ))}
        </nav>

        <div className="flex gap-4">
          {!isConnected ? (
            <button onClick={async () => {
              try {
                const port = await (navigator as any).serial.requestPort();
                await port.open({ baudRate: 115200 });
                portRef.current = port;
                const encoder = new TextEncoderStream(); encoder.readable.pipeTo(port.writable);
                writerRef.current = encoder.writable.getWriter();
                setIsConnected(true); addLog("SERIAL: Connected"); readFromSerial(port);
              } catch(e) { addLog("SERIAL ERROR: Connection failed."); }
            }} className="flex items-center gap-2 px-6 py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-900 font-bold rounded-xl transition-all shadow-xl shadow-emerald-500/20 active:scale-95"><Zap className="w-4 h-4 fill-current" /> Link Printer</button>
          ) : (
            <div className="flex items-center gap-3">
              <button 
                onClick={isScanning ? () => { masterQueueRef.current = []; setIsScanning(false); addLog("SCANNER: Aborted"); } : handleStartScan} 
                disabled={isScanning}
                className={`flex items-center gap-2 px-6 py-3 font-bold rounded-xl transition-all shadow-xl ${isScanning ? 'bg-slate-800 text-slate-500 cursor-allowed' : 'bg-cyan-500 text-slate-900 shadow-cyan-500/20'}`}
              >
                {isScanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
                {isScanning ? 'Scan in Progress' : 'Start Scan'}
              </button>
              <button onClick={() => { masterQueueRef.current = []; setRemainingItems(0); setIsScanning(false); setIsPrinterReady(true); }} className="p-3 bg-slate-800 text-slate-400 rounded-xl hover:text-rose-400 transition-colors shadow-lg"><Power className="w-5 h-5" /></button>
            </div>
          )}
        </div>
      </header>

      <main className="w-full">
        {activeTab === 'config' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 animate-in fade-in duration-500">
            <div className="lg:col-span-4 space-y-6">
              <div className="bg-slate-900/50 border border-slate-800 rounded-3xl p-8 backdrop-blur-xl shadow-2xl space-y-8">
                <div>
                   <div className="flex justify-between items-center mb-6">
                      <h3 className="text-xs font-black uppercase tracking-widest text-cyan-500 flex items-center gap-2"><Settings className="w-4 h-4" /> Optical & Spatial</h3>
                      <div className="flex bg-slate-900 rounded-lg p-0.5 border border-slate-800">
                        {(['in', 'cm'] as const).map(u => (
                          <button
                            key={u}
                            onClick={() => setSettings(s => ({...s, units: u}))}
                            className={`px-3 py-1 rounded-md text-[10px] font-black uppercase transition-all ${settings.units === u ? 'bg-cyan-500 text-slate-900 shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}
                          >
                            {u}
                          </button>
                        ))}
                      </div>
                   </div>
                   <div className="space-y-6">
                    <div className="grid grid-cols-2 gap-4">
                      <NumberInput label="Sample Width" value={settings.sampleWidth} onChange={v => setSettings(s => ({...s, sampleWidth: v}))} suffix={settings.units} />
                      <NumberInput label="Sample Height" value={settings.sampleHeight} onChange={v => setSettings(s => ({...s, sampleHeight: v}))} suffix={settings.units} />
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <NumberInput label="Magnification" value={settings.magnification} onChange={v => setSettings(s => ({...s, magnification: v}))} suffix="x" />
                      <NumberInput label="Tile Overlap" value={settings.overlapPercent} onChange={v => setSettings(s => ({...s, overlapPercent: v}))} suffix="%" />
                    </div>

                    <div className="p-4 bg-slate-800/50 rounded-xl flex items-center justify-between border border-white/5">
                        <div>
                          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Pixel Resolution</p>
                          <p className="text-xs font-bold text-cyan-400">{(pixelResolution * (settings.depthDownscale && videoDimensions.width > 2000 ? 2 : 1)).toFixed(2)} μm/px</p>
                        </div>
                        <Search className="w-4 h-4 text-slate-600" />
                    </div>
                  </div>
                </div>

                <div>
                   <h3 className="text-xs font-black uppercase tracking-widest text-amber-500 mb-6 flex items-center justify-between">
                     <div className="flex items-center gap-2"><Layers className="w-4 h-4" /> Z-Stacking Config</div>
                     <div className="group relative cursor-help">
                        <HelpCircle className="w-3 h-3 text-slate-600" />
                        <div className="absolute right-0 bottom-full mb-2 w-48 p-2 bg-slate-950 border border-slate-800 rounded-lg shadow-2xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-[60]">
                           <p className="text-[10px] font-bold text-slate-300">Uses Sobel Gradient Magnitude to identify sharpest focus across slices.</p>
                        </div>
                     </div>
                   </h3>
                   <div className="grid grid-cols-2 gap-4">
                    <NumberInput label="Stack Count" min={1} value={settings.zStackCount} onChange={v => setSettings(s => ({...s, zStackCount: v}))} suffix="img" />
                    <NumberInput label="Z Step Size" min={10} value={settings.zStepMicrons} onChange={v => setSettings(s => ({...s, zStepMicrons: v}))} suffix="μm" />
                  </div>
                  
                  <div className="mt-4 flex items-center justify-between p-4 bg-slate-800/30 rounded-xl border border-white/5">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Downscale to 1080p</span>
                      <span className="text-[8px] text-slate-600 italic">Reduces computation time by 4x</span>
                    </div>
                    <button 
                      onClick={() => setSettings(s => ({...s, depthDownscale: !s.depthDownscale}))}
                      className={`w-10 h-5 rounded-full transition-all relative ${settings.depthDownscale ? 'bg-cyan-500' : 'bg-slate-700'}`}
                    >
                      <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${settings.depthDownscale ? 'left-6' : 'left-1'}`} />
                    </button>
                  </div>
                </div>

                <div>
                   <h3 className="text-xs font-black uppercase tracking-widest text-emerald-500 mb-6 flex items-center gap-2"><Timer className="w-4 h-4" /> Motion Timings</h3>
                   <div className="grid grid-cols-2 gap-4">
                    <NumberInput label="XY Stabilize" min={0} value={settings.stabilizeXYMs} onChange={v => setSettings(s => ({...s, stabilizeXYMs: v}))} suffix="ms" />
                    <NumberInput label="Z Settle" min={0} value={settings.settleZMs} onChange={v => setSettings(s => ({...s, settleZMs: v}))} suffix="ms" />
                  </div>
                  
                  <div className="mt-6 flex flex-col gap-1">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">G-Code Flavor</label>
                    <select 
                      value={settings.gcodeFlavor}
                      onChange={(e) => setSettings(s => ({...s, gcodeFlavor: e.target.value as any}))}
                      className="bg-slate-900 border border-slate-800 text-white text-xs font-bold rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-emerald-500/50 outline-none transition-all"
                    >
                      <option value="marlin">Marlin (ms)</option>
                      <option value="grbl">Grbl (s)</option>
                    </select>
                    <p className="text-[9px] text-slate-600 mt-1 italic">Marlin uses ms for G4 P. Grbl uses s.</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="lg:col-span-8 space-y-8">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="WD (Work Dist)" value={specs.wd.toFixed(1)} suffix="mm" icon={<Ruler className="w-4 h-4" />} />
                <StatCard label="DOF (Focus Depth)" value={(specs.dof * 1000).toFixed(0)} suffix="μm" icon={<Layers className="w-4 h-4 text-amber-500" />} />
                <StatCard label="FOV Width" value={specs.fovX.toFixed(2)} suffix="mm" icon={<Maximize2 className="w-4 h-4 text-cyan-400" />} />
                <StatCard label="Tiles Req." value={`${grid.cols}x${grid.rows}`} icon={<LayoutGrid className="w-4 h-4 text-emerald-400" />} highlight />
              </div>
              <Visualizer settings={settings} grid={grid} />
            </div>
          </div>
        )}

        {activeTab === 'jog' && (
          <JogController 
            stackedResults={stackedResults} 
            onSendCommand={sendManualCommand} 
            isConnected={isConnected} 
            isPrinterReady={isPrinterReady} 
            onConnect={() => {}} 
            onDisconnect={() => setIsConnected(false)} 
            queueSize={remainingItems}
            stepSize={jogStep}
            setStepSize={setJogStep}
            feedrate={jogFeedrate}
            setFeedrate={setJogFeedrate}
          />
        )}
        {activeTab === 'manual' && (
          <ManualCapture
            onSendCommand={sendManualCommand}
            onCapture={takeManualSnapshot}
            manualCaptures={manualCaptures}
            setManualCaptures={setManualCaptures}
            isConnected={isConnected}
            isPrinterReady={isPrinterReady}
            queueSize={remainingItems}
            stepSize={jogStep}
            setStepSize={setJogStep}
            feedrate={jogFeedrate}
            setFeedrate={setJogFeedrate}
          />
        )}
        {activeTab === 'stacking' && <StackingLab results={stackedResults} capturedImages={groupedCapturedImages} />}
        {activeTab === 'depth' && (
          <DepthLab 
            results={depthResults} 
            capturedImages={groupedCapturedImages} 
            onTriggerDepth={handleTriggerDepth} 
            onClearDepth={handleClearDepth}
            grid={grid} 
            settings={settings} 
          />
        )}
        {activeTab === 'stitching' && <StitchingView images={capturedImages} stackedResults={stackedResults} grid={grid} settings={settings} />}
        {activeTab === 'gallery' && (
          <div className="space-y-8 animate-in fade-in duration-500">
            <div className="flex justify-between items-end">
              <div><h2 className="text-2xl font-black text-white">Capture Library</h2><p className="text-xs text-slate-500 uppercase tracking-widest mt-1">Managed Z-Stack Repositories</p></div>
              <div className="flex gap-4">
                <button onClick={handleDownloadAllStructured} className="px-6 py-3 bg-cyan-500 text-slate-900 rounded-2xl font-black text-xs shadow-xl active:scale-95 transition-all"><FolderDown className="w-4 h-4 inline mr-2" /> Download Project ZIP</button>
                <button onClick={handleClearAllData} className="px-6 py-3 bg-rose-500/10 text-rose-500 border border-rose-500/20 rounded-2xl font-black text-xs hover:bg-rose-500 hover:text-white transition-all"><Trash2 className="w-4 h-4 inline mr-2" /> Clear All Imagery</button>
              </div>
            </div>
            <div className="space-y-8">
              {Object.keys(groupedCapturedImages).length === 0 ? (
                <div className="py-24 flex flex-col items-center justify-center bg-slate-900/30 rounded-[3rem] border-2 border-dashed border-slate-800">
                   <ImageIcon className="w-16 h-16 text-slate-800 mb-4" />
                   <p className="text-slate-500 font-black uppercase tracking-widest text-xs">Waiting for first scan capture...</p>
                </div>
              ) : (
                (Object.entries(groupedCapturedImages) as [string, CapturedImage[]][]).map(([label, images]) => (
                  <div key={label} className="bg-slate-900/40 border border-slate-800 rounded-[2rem] p-6 space-y-4">
                    <div className="flex justify-between items-center">
                      <h3 className="text-lg font-black text-white flex items-center gap-3">
                        <div className="w-8 h-8 bg-slate-800 rounded-lg flex items-center justify-center text-xs text-cyan-400 border border-slate-700 font-mono">{label}</div>
                        Position {label}
                      </h3>
                    </div>
                    <div className="grid grid-cols-4 md:grid-cols-8 lg:grid-cols-10 gap-3">
                      {images.map(img => (
                        <div key={img.id} className="aspect-square rounded-xl overflow-hidden bg-black border border-slate-800 hover:border-cyan-500/50 transition-colors cursor-zoom-in group relative">
                          <img src={img.dataUrl} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500" />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-[8px] font-black text-white pointer-events-none">Z={img.gridPos.z}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

const StatCard: React.FC<{ label: string; value: number | string; icon: React.ReactNode; highlight?: boolean; suffix?: string }> = ({ label, value, icon, highlight, suffix }) => (
  <div className={`p-5 rounded-3xl border ${highlight ? 'bg-cyan-500/10 border-cyan-500/50 shadow-cyan-500/5' : 'bg-slate-900/50 border-slate-800 shadow-lg'} flex items-center gap-5 transition-all hover:-translate-y-1 hover:border-slate-700`}>
    <div className={`p-3 rounded-2xl ${highlight ? 'bg-cyan-500 text-slate-900' : 'bg-slate-800 text-slate-400'}`}>{icon}</div>
    <div>
      <p className="text-[10px] uppercase font-black tracking-widest text-slate-500 mb-1 leading-none">{label}</p>
      <div className="flex items-baseline gap-1">
        <span className={`text-xl font-black ${highlight ? 'text-cyan-400' : 'text-slate-100'}`}>{value}</span>
        {suffix && <span className="text-[10px] font-bold text-slate-600 uppercase">{suffix}</span>}
      </div>
    </div>
  </div>
);

export default App;
