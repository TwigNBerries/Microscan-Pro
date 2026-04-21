
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
import DataProcessing from './components/DataProcessing';
import ManualCapture from './components/ManualCapture';
import MagnificationVerifier from './components/MagnificationVerifier';
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
  Map,
  FileUp,
  Sliders
} from 'lucide-react';

interface CameraControlState {
  autoExposure: boolean;
  exposure: number;
  exposureMin: number;
  exposureMax: number;
  gain: number;
  gainMin: number;
  gainMax: number;
}

type QueueItem =
  | { type: 'GCODE'; value: string }
  | { type: 'CAPTURE'; label: string; r: number; c: number; z: number };

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'config' | 'jog' | 'manual' | 'verify' | 'gallery' | 'stitching' | 'stacking' | 'depth' | 'processing'>('config');
  const [filteredResults, setFilteredResults] = useState<Record<string, DepthResult>>({});
  const [rotateFrames, setRotateFrames] = useState(false);
  const [showCamera, setShowCamera] = useState(true);

  // Continuously poll the microscope for its current AMR magnification.
  // Pauses while the tab is hidden to avoid burning USB cycles.
  // Fast mode (0.5 s) for responsive dial adjustment; Slow mode (3 s) for
  // when the user is busy doing other things and doesn't want USB churn.
  const [amrLive, setAmrLive] = useState(false);
  const [amrError, setAmrError] = useState<string | null>(null);
  const [amrFastPoll, setAmrFastPoll] = useState(true);
  const amrInFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      // Skip if tab hidden, component unmounted, or a previous call is still
      // running — each Python invocation loads DNX64.dll and takes ~2 s, so
      // piling up concurrent requests would thrash the USB bus.
      if (cancelled || document.hidden || amrInFlightRef.current) return;
      amrInFlightRef.current = true;
      try {
        const res = await fetch('/api/microscope/amr');
        const data = await res.json();
        if (cancelled) return;
        if (data.supported) {
          setAmrLive(true);
          setAmrError(null);
          // Only push a state update if the value actually changed — avoids
          // spurious re-renders of FOV/grid calculations on every tick.
          setSettings(s => s.magnification !== data.magnification
            ? { ...s, magnification: data.magnification }
            : s);
        } else {
          setAmrLive(false);
          setAmrError(data.error || 'unsupported');
        }
      } catch {
        if (cancelled) return;
        setAmrLive(false);
        setAmrError('server unreachable');
      } finally {
        amrInFlightRef.current = false;
      }
    };
    poll();                                                    // initial read
    // Each server request spawns a fresh Python process that re-Inits the
    // DNX64 DLL (the only reliable way to get a non-cached AMR reading),
    // which takes ~2 s.  The in-flight guard above means we never queue
    // more than one, so the interval is really just "how soon should we
    // try again once the previous call finishes."  Fast mode fires ASAP
    // (effective cadence ≈ 2 s); slow mode waits a few seconds between
    // reads to keep CPU/USB load low when the user isn't touching the dial.
    const intervalMs = amrFastPoll ? 500 : 5000;
    const id = setInterval(poll, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [amrFastPoll]);

  const [currentZ, setCurrentZ] = useState(0);
  const [cameraControlsOpen, setCameraControlsOpen] = useState(false);
  const [cameraState, setCameraState] = useState<CameraControlState | null>(null);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [cameraApplying, setCameraApplying] = useState(false);
  const [cameraApplyResult, setCameraApplyResult] = useState<'ok' | 'error' | null>(null);
  const cameraInFlightRef = useRef(false);
  
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
  const [stitchedMosaicUrl, setStitchedMosaicUrl] = useState<string | null>(null);
  const [stackedResults, setStackedResults] = useState<Record<string, StackResult>>({});
  const [depthResults, setDepthResults] = useState<Record<string, DepthResult>>({});
  const [isExporting, setIsExporting] = useState(false);

  const portRef = useRef<any>(null);
  const writerRef = useRef<any>(null);
  const readerRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
      setStitchedMosaicUrl(null);
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
    setFilteredResults(prev => {
      if (!(label in prev)) return prev;
      const next = { ...prev };
      delete next[label];
      return next;
    });
    setDepthResults(prev => ({
      ...prev,
      [label]: { label, dataUrl: "", depthValues: [], width: 0, height: 0, isProcessing: true, minZ: 0, maxZ: 0, method }
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
          minZ: result.minZ,
          maxZ: result.maxZ,
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

  const fetchCameraState = useCallback(async () => {
    if (cameraInFlightRef.current) return;
    cameraInFlightRef.current = true;
    setCameraLoading(true);
    try {
      const res = await fetch('/api/microscope/camera');
      const data = await res.json();
      if (data.ok) {
        const { ok: _ok, error: _err, ...cam } = data;
        setCameraState(cam as CameraControlState);
      } else {
        setCameraState(null);
        addLog(`CAMERA CTRL: Read failed — ${data.error}`);
      }
    } catch {
      setCameraState(null);
      addLog('CAMERA CTRL: Server unreachable');
    } finally {
      setCameraLoading(false);
      cameraInFlightRef.current = false;
    }
  }, [addLog]);

  const applyCameraSettings = useCallback(async () => {
    if (!cameraState || cameraInFlightRef.current) return;
    cameraInFlightRef.current = true;
    setCameraApplying(true);
    setCameraApplyResult(null);
    try {
      const res = await fetch('/api/microscope/camera', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          autoExposure: cameraState.autoExposure,
          exposure: Math.max(cameraState.exposureMin, Math.min(cameraState.exposureMax, cameraState.exposure)),
          gain: Math.max(cameraState.gainMin, Math.min(cameraState.gainMax, cameraState.gain)),
        }),
      });
      const data = await res.json();
      setCameraApplyResult(data.ok ? 'ok' : 'error');
      if (!data.ok) addLog(`CAMERA CTRL: Apply failed — ${data.error}`);
    } catch {
      setCameraApplyResult('error');
      addLog('CAMERA CTRL: Apply request failed');
    } finally {
      setCameraApplying(false);
      cameraInFlightRef.current = false;
      setTimeout(() => setCameraApplyResult(null), 2000);
    }
  }, [cameraState, addLog]);

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

  useEffect(() => {
    if (cameraControlsOpen && cameraState === null && !cameraLoading) {
      fetchCameraState();
    }
  }, [cameraControlsOpen, cameraState, cameraLoading, fetchCameraState]);

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
    cmd.split('\n').filter(l => l.trim()).forEach(l => {
      const trimmed = l.trim().toUpperCase();
      // Track Z position optimistically
      if (trimmed.startsWith('G1') && trimmed.includes('Z')) {
        const match = trimmed.match(/Z([-+]?[0-9]*\.?[0-9]+)/);
        if (match) {
          const val = parseFloat(match[1]);
          if (trimmed.includes('G91')) {
            // Relative move (though JogController sends G91 then G1 then G90)
            // This is tricky because G91/G90 are separate lines in cmd.split('\n')
          } else {
            // Absolute move
            // setCurrentZ(val); // We need to know if we are in G91 or G90
          }
        }
      }
      masterQueueRef.current.push({ type: 'GCODE', value: l });
    });
    setRemainingItems(masterQueueRef.current.length);
  };

  const handleJog = useCallback(async (axis: 'X' | 'Y' | 'Z', distance: number, feedrate: number) => {
    if (!isConnected) return;
    const f = axis === 'Z' ? 600 : feedrate;
    const cmd = `G91\nG1 ${axis}${distance} F${f}\nG90`;
    
    if (axis === 'Z') {
      setCurrentZ(prev => prev + distance);
    }
    
    await sendManualCommand(cmd);
  }, [isConnected, sendManualCommand]);

  const handleHome = useCallback(async () => {
    if (!isConnected) return;
    await sendManualCommand("G28");
    setCurrentZ(0); // Assume homing sets Z to 0
  }, [isConnected, sendManualCommand]);

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
    
    // Add metadata for future imports
    const metadata = {
      settings,
      grid,
      images: capturedImages.map(img => ({
        filename: `Stack_${img.label}/${img.name}.jpg`,
        label: img.label,
        name: img.name,
        gridPos: img.gridPos,
        timestamp: img.timestamp
      }))
    };
    zip.file("metadata.json", JSON.stringify(metadata, null, 2));

    capturedImages.forEach(img => zip.file(`Stack_${img.label}/${img.name}.jpg`, img.dataUrl.split(',')[1], { base64: true }));
    const content = await zip.generateAsync({ type: "blob" });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content); link.download = `MicroScan_Project_${Date.now()}.zip`; link.click();
    setIsExporting(false);
  };

  const handleImportFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newImages: CapturedImage[] = [];
    addLog(`SYSTEM: Importing ${files.length} files...`);

    try {
      for (const file of Array.from(files)) {
        if (file.name.endsWith('.zip')) {
          const zip = await JSZip.loadAsync(file);
          
          // Check for metadata.json
          let metadata: any = null;
          if (zip.files["metadata.json"]) {
            const metaStr = await zip.files["metadata.json"].async("string");
            metadata = JSON.parse(metaStr);
            if (metadata.settings) setSettings(metadata.settings);
            addLog("SYSTEM: Applied scan settings from metadata.");
          }

          const imageFiles = Object.keys(zip.files).filter(name => !zip.files[name].dir && /\.(jpg|jpeg|png)$/i.test(name));
          
          for (const name of imageFiles) {
            const content = await zip.files[name].async('base64');
            const dataUrl = `data:image/jpeg;base64,${content}`;
            
            // Try to find in metadata
            const metaEntry = metadata?.images?.find((img: any) => img.filename === name);
            
            if (metaEntry) {
              newImages.push({
                id: Math.random().toString(36).substr(2, 9),
                name: metaEntry.name,
                label: metaEntry.label,
                dataUrl,
                timestamp: metaEntry.timestamp || Date.now(),
                gridPos: metaEntry.gridPos
              });
            } else {
              const pathParts = name.split('/');
              const fileName = pathParts[pathParts.length - 1];
              const labelMatch = name.match(/Stack_([A-Z0-9]+)/i) || fileName.match(/^([A-Z0-9]+)_/i);
              const zMatch = fileName.match(/_(\d+)\./);
              
              const label = labelMatch ? labelMatch[1] : 'IMPORTED';
              const z = zMatch ? parseInt(zMatch[1]) : 0;
              
              newImages.push({
                id: Math.random().toString(36).substr(2, 9),
                name: fileName.split('.')[0],
                label,
                dataUrl,
                timestamp: Date.now(),
                gridPos: { r: 0, c: 0, z }
              });
            }
          }
        } else if (file.type.startsWith('image/')) {
          const reader = new FileReader();
          const dataUrl = await new Promise<string>((resolve) => {
            reader.onload = (e) => resolve(e.target?.result as string);
            reader.readAsDataURL(file);
          });

          const fileName = file.name;
          const labelMatch = fileName.match(/^([A-Z0-9]+)_/i);
          const zMatch = fileName.match(/_(\d+)\./);
          
          const label = labelMatch ? labelMatch[1] : 'IMPORTED';
          const z = zMatch ? parseInt(zMatch[1]) : 0;

          newImages.push({
            id: Math.random().toString(36).substr(2, 9),
            name: fileName.split('.')[0],
            label,
            dataUrl,
            timestamp: Date.now(),
            gridPos: { r: 0, c: 0, z }
          });
        }
      }

      if (newImages.length > 0) {
        setCapturedImages(prev => [...newImages, ...prev]);
        addLog(`SYSTEM: Successfully imported ${newImages.length} images.`);
      }
    } catch (err) {
      addLog(`SYSTEM ERROR: Import failed. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
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

             {/* Camera Controls — always-visible toggle + collapsible panel */}
             <div className="absolute top-6 right-6 flex flex-col items-end gap-2">
               {/* Hover-only utility buttons */}
               <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                 <button onClick={startCamera} className="p-3 bg-black/60 rounded-full text-white hover:bg-cyan-500 hover:text-slate-900 transition-all backdrop-blur-md border border-white/10"><RefreshCw className="w-4 h-4" /></button>
                 <button onClick={() => setShowCamera(false)} className="p-3 bg-black/60 rounded-full text-white hover:bg-black transition-colors backdrop-blur-md border border-white/10"><ChevronDown className="w-4 h-4" /></button>
               </div>

               {/* Always-visible camera controls toggle */}
               <button
                 onClick={() => setCameraControlsOpen(v => {
                   if (!v) setCameraState(null);
                   return !v;
                 })}
                 title="Camera Controls"
                 className="flex items-center gap-1.5 px-2.5 py-1.5 bg-black/60 backdrop-blur-md border border-white/10 rounded-full text-white hover:bg-slate-800 transition-all text-[10px] font-bold"
               >
                 <Camera className="w-3 h-3" />
                 <span className="hidden md:inline">CAM</span>
                 <ChevronDown className={`w-3 h-3 transition-transform ${cameraControlsOpen ? 'rotate-180' : ''}`} />
               </button>

               {/* Collapsible camera controls panel */}
               {cameraControlsOpen && (
                 <div className="w-52 bg-slate-900/90 backdrop-blur-xl border border-slate-700/60 rounded-2xl p-4 flex flex-col gap-3 shadow-2xl">
                   <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Camera Controls</p>

                   {cameraLoading && (
                     <div className="flex items-center gap-2 text-slate-400 text-[10px]">
                       <Loader2 className="w-3 h-3 animate-spin" />
                       Reading from scope…
                     </div>
                   )}

                   {!cameraLoading && cameraState === null && (
                     <div className="flex flex-col gap-2">
                       <p className="text-[10px] text-red-400">Could not read microscope state</p>
                       <button
                         onClick={fetchCameraState}
                         className="text-[10px] font-bold text-cyan-400 hover:text-cyan-300 text-left"
                       >
                         Retry
                       </button>
                     </div>
                   )}

                   {!cameraLoading && cameraState !== null && (
                     <>
                       {/* Auto-Exposure toggle */}
                       <div className="flex items-center justify-between">
                         <span className="text-[10px] font-bold text-slate-300">Auto Exposure</span>
                         <button
                           onClick={() => setCameraState(s => s ? { ...s, autoExposure: !s.autoExposure } : s)}
                           className={`relative w-9 h-5 rounded-full transition-colors border ${
                             cameraState.autoExposure
                               ? 'bg-cyan-500 border-cyan-400'
                               : 'bg-slate-700 border-slate-600'
                           }`}
                         >
                           <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                             cameraState.autoExposure ? 'translate-x-4' : 'translate-x-0.5'
                           }`} />
                         </button>
                       </div>

                       {/* Shutter Speed slider */}
                       <div className={`flex flex-col gap-1 ${cameraState.autoExposure ? 'opacity-40 pointer-events-none' : ''}`}>
                         <div className="flex justify-between">
                           <span className="text-[10px] font-bold text-slate-300">Shutter Speed</span>
                           <span className="text-[10px] font-mono text-cyan-400">{cameraState.exposure}</span>
                         </div>
                         <input
                           type="range"
                           min={cameraState.exposureMin}
                           max={cameraState.exposureMax}
                           value={cameraState.exposure}
                           disabled={cameraState.autoExposure}
                           onChange={e => setCameraState(s => s ? { ...s, exposure: Number(e.target.value) } : s)}
                           className="w-full accent-cyan-500"
                         />
                       </div>

                       {/* Gain slider */}
                       <div className={`flex flex-col gap-1 ${cameraState.autoExposure ? 'opacity-40 pointer-events-none' : ''}`}>
                         <div className="flex justify-between">
                           <span className="text-[10px] font-bold text-slate-300">Gain</span>
                           <span className="text-[10px] font-mono text-cyan-400">{cameraState.gain}</span>
                         </div>
                         <input
                           type="range"
                           min={cameraState.gainMin}
                           max={cameraState.gainMax}
                           value={cameraState.gain}
                           disabled={cameraState.autoExposure}
                           onChange={e => setCameraState(s => s ? { ...s, gain: Number(e.target.value) } : s)}
                           className="w-full accent-cyan-500"
                         />
                       </div>

                       {/* Apply button */}
                       <button
                         onClick={applyCameraSettings}
                         disabled={cameraApplying}
                         className={`w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${
                           cameraApplyResult === 'ok'
                             ? 'bg-emerald-500 text-white'
                             : cameraApplyResult === 'error'
                             ? 'bg-red-500 text-white'
                             : 'bg-cyan-500 text-slate-900 hover:bg-cyan-400 disabled:opacity-50 disabled:cursor-not-allowed'
                         }`}
                       >
                         {cameraApplying
                           ? <Loader2 className="w-3 h-3 animate-spin" />
                           : cameraApplyResult === 'ok'
                           ? 'Applied ✓'
                           : cameraApplyResult === 'error'
                           ? 'Error ✗'
                           : 'Apply'}
                       </button>
                     </>
                   )}
                 </div>
               )}
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
            { id: 'verify', label: 'Verify', icon: Ruler },
            { id: 'stacking', label: 'Stack', icon: Sparkles },
            { id: 'depth', label: 'Depth', icon: Map },
            { id: 'processing', label: 'Process', icon: Sliders },
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
                      <div className="flex flex-col gap-1.5 w-full">
                        <label className="text-sm font-medium text-slate-400 uppercase tracking-wider flex items-center gap-2">
                          <span>Magnification</span>
                          {amrLive && (
                            <span
                              title="Reading magnification live from microscope"
                              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 text-[9px] font-black tracking-widest"
                            >
                              <span className="relative flex w-1.5 h-1.5">
                                <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-75" />
                                <span className="relative w-1.5 h-1.5 rounded-full bg-emerald-400" />
                              </span>
                              LIVE
                            </span>
                          )}
                        </label>
                        <div className="flex gap-2">
                          <div className="relative flex-1">
                            <input
                              type="number"
                              value={settings.magnification}
                              onChange={e => setSettings(s => ({...s, magnification: parseFloat(e.target.value) || 0}))}
                              step={1}
                              readOnly={amrLive}
                              title={amrLive ? "Magnification is being read live from the microscope" : undefined}
                              className={`w-full bg-slate-800 border rounded-lg px-4 py-2.5 text-white focus:outline-none transition-all ${
                                amrLive
                                  ? 'border-emerald-500/40 cursor-not-allowed focus:ring-2 focus:ring-emerald-500/50'
                                  : 'border-slate-700 focus:ring-2 focus:ring-cyan-500'
                              }`}
                            />
                            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 text-sm pointer-events-none">x</span>
                          </div>
                          <button
                            onClick={() => setAmrFastPoll(v => !v)}
                            title={amrFastPoll
                              ? "Continuous polling (~2 s per update, DLL-limited) — click to slow to ~5 s"
                              : "Slow polling (~5 s) — click for continuous updates (~2 s)"}
                            className={`flex-shrink-0 flex flex-col items-center justify-center w-10 h-10 rounded-lg border transition-all font-black ${
                              amrFastPoll
                                ? 'bg-cyan-500/15 border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/25'
                                : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300'
                            }`}
                          >
                            <span className="text-[9px] leading-none tracking-tight">
                              {amrFastPoll ? '~2s' : '~5s'}
                            </span>
                            <span className="text-[7px] leading-none mt-0.5 opacity-70">
                              {amrFastPoll ? 'FAST' : 'SLOW'}
                            </span>
                          </button>
                        </div>
                        {!amrLive && amrError && (
                          <p className="text-[10px] font-bold text-slate-500 truncate" title={amrError}>
                            {amrError === 'unsupported' ? 'Manual entry — microscope not detected' : `Error: ${amrError}`}
                          </p>
                        )}
                      </div>
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
            onJog={handleJog}
            onHome={handleHome}
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
            onJog={handleJog}
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
        {activeTab === 'verify' && (
          <MagnificationVerifier
            settings={settings}
            setSettings={setSettings}
            currentZ={currentZ}
            onJog={handleJog}
            onHome={handleHome}
            isConnected={isConnected}
            isPrinterReady={isPrinterReady}
            onProceed={() => setActiveTab('config')}
            onReturn={() => setActiveTab('config')}
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
            rotateFrames={rotateFrames}
            setRotateFrames={setRotateFrames}
          />
        )}
        {activeTab === 'processing' && (
          <DataProcessing
            results={depthResults}
            filteredResults={filteredResults}
            setFilteredResults={setFilteredResults}
            grid={grid}
            settings={settings}
            rotateFrames={rotateFrames}
          />
        )}
        {activeTab === 'stitching' && (
          <StitchingView 
            images={capturedImages} 
            stackedResults={stackedResults} 
            grid={grid} 
            settings={settings}
            stitchedMosaicUrl={stitchedMosaicUrl}
            setStitchedMosaicUrl={setStitchedMosaicUrl}
          />
        )}
        {activeTab === 'gallery' && (
          <div className="space-y-8 animate-in fade-in duration-500">
            <div className="flex justify-between items-end">
              <div><h2 className="text-2xl font-black text-white">Capture Library</h2><p className="text-xs text-slate-500 uppercase tracking-widest mt-1">Managed Z-Stack Repositories</p></div>
              <div className="flex gap-4">
                <button onClick={() => fileInputRef.current?.click()} className="px-6 py-3 bg-slate-800 text-white border border-slate-700 rounded-2xl font-black text-xs hover:bg-slate-700 transition-all flex items-center gap-2">
                  <FileUp className="w-4 h-4" /> Import Scan Data
                </button>
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  className="hidden" 
                  accept=".zip,image/*" 
                  multiple 
                  onChange={handleImportFiles} 
                />
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