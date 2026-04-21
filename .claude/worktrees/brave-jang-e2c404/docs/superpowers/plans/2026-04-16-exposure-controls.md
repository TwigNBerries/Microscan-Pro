# Exposure Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible camera-control overlay panel to the live video feed that exposes auto-exposure toggle, shutter speed slider, and gain slider — all backed by the Dino-Lite DNX64 SDK.

**Architecture:** Two new Python scripts (`get_camera_state.py`, `set_camera.py`) follow the existing `get_amr.py` per-spawn pattern — each calls `Init()`, reads or writes hardware state, emits one JSON line, and force-exits. Two new Express routes spawn those scripts. A new collapsible overlay panel in `App.tsx` reads on open and writes on Apply.

**Tech Stack:** React 19, TypeScript, TailwindCSS, Lucide icons, Express 5, Node.js `child_process.spawn`, Python 3 + ctypes, Dino-Lite DNX64 SDK (Windows COM/ActiveX).

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| **Create** | `services/get_camera_state.py` | Read auto-exposure, exposure value, gain + ranges from hardware in one Init() session |
| **Create** | `services/set_camera.py` | Write auto-exposure, exposure, gain to hardware in one Init() session |
| **Modify** | `server.ts` | Add `GET /api/microscope/camera` and `POST /api/microscope/camera` routes |
| **Modify** | `App.tsx` | Add camera control state, fetch helpers, and collapsible overlay panel inside the floating video feed |

---

## Task 1: `get_camera_state.py`

**Files:**
- Create: `services/get_camera_state.py`

- [ ] **Step 1: Create the script**

Create `services/get_camera_state.py` with the following content:

```python
#!/usr/bin/env python3
"""
Read current camera state from the Dino-Lite microscope via DNX64 SDK.
Prints one JSON line to stdout and exits. Used by GET /api/microscope/camera.
"""
import os, sys, json, time, importlib.util, ctypes


def log(msg: str) -> None:
    sys.stderr.write(f"GET_CAMERA: {msg}\n")
    sys.stderr.flush()


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main():
    services_dir = os.path.dirname(os.path.abspath(__file__))

    if hasattr(os, 'add_dll_directory'):
        try:
            os.add_dll_directory(services_dir)
            log("added services/ to DLL search path")
        except Exception as e:
            log(f"add_dll_directory failed: {e}")

    try:
        hr = ctypes.windll.ole32.CoInitializeEx(None, 0x2)
        log(f"CoInitializeEx hr=0x{hr & 0xFFFFFFFF:08X}")
    except Exception as e:
        log(f"CoInitializeEx failed (non-fatal): {e}")

    dll_path = os.path.join(services_dir, 'DNX64.dll')
    if not os.path.exists(dll_path):
        emit({"ok": False, "error": "DNX64.dll not found in services/"})
        return

    api_path = os.path.join(services_dir, 'DNX64_api.py')
    if not os.path.exists(api_path):
        emit({"ok": False, "error": "DNX64_api.py not found in services/"})
        return

    try:
        spec = importlib.util.spec_from_file_location("DNX64_api", api_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        DNX64 = mod.DNX64
        log("DNX64_api wrapper loaded")
    except Exception as e:
        emit({"ok": False, "error": f"Failed to load API wrapper: {e}"})
        return

    try:
        scope = DNX64(dll_path)
        log("DLL loaded")
    except Exception as e:
        emit({"ok": False, "error": f"Failed to load DNX64.dll: {e}"})
        return

    try:
        log("SetVideoDeviceIndex(0)")
        scope.SetVideoDeviceIndex(0)
        time.sleep(0.1)

        log("Init()...")
        ok = scope.Init()
        log(f"Init() = {ok}")
        if not ok:
            emit({"ok": False, "error": "Microscope not detected. Is it plugged in and not claimed by DinoCapture?"})
            return

        auto_exposure = int(scope.GetAutoExposure(0))
        log(f"GetAutoExposure = {auto_exposure}")

        exposure = int(scope.GetExposureValue(0))
        log(f"GetExposureValue = {exposure}")

        gain = int(scope.GetVideoProcAmp(9))
        log(f"GetVideoProcAmp(9) [gain] = {gain}")

        # Query gain range dynamically; index 9 = DirectShow Gain property
        _, gain_min, gain_max, _step, _default = scope.GetVideoProcAmpValueRange(9)
        log(f"Gain range: {gain_min}..{gain_max}")

        emit({
            "ok": True,
            "autoExposure": bool(auto_exposure),
            "exposure": exposure,
            "exposureMin": 0,
            "exposureMax": 32767,
            "gain": gain,
            "gainMin": int(gain_min),
            "gainMax": int(gain_max),
        })

    except Exception as e:
        emit({"ok": False, "error": f"Error reading camera state: {e}"})


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
```

- [ ] **Step 2: Smoke-test the script manually**

With the microscope plugged in and DinoCapture closed, run:

```bash
cd "C:\Users\jonah\Downloads\Microscan-Pro-main\Microscan-Pro-main"
py services/get_camera_state.py
```

Expected: one JSON line on stdout ending with `"ok": true` and numeric values for `autoExposure`, `exposure`, `gain`, `gainMin`, `gainMax`. Stderr will show diagnostic lines starting with `GET_CAMERA:`.

If the DLL is missing: `{"ok": false, "error": "DNX64.dll not found in services/"}`.

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\jonah\Downloads\Microscan-Pro-main\Microscan-Pro-main"
git add services/get_camera_state.py
git commit -m "feat: add get_camera_state.py to read exposure/gain from DNX64"
```

---

## Task 2: `set_camera.py`

**Files:**
- Create: `services/set_camera.py`

- [ ] **Step 1: Create the script**

Create `services/set_camera.py` with the following content:

```python
#!/usr/bin/env python3
"""
Write auto-exposure, exposure value, and gain to the Dino-Lite microscope
via DNX64 SDK. Accepts CLI args. Prints one JSON line and exits.
Used by POST /api/microscope/camera.
"""
import os, sys, json, time, importlib.util, ctypes, argparse


def log(msg: str) -> None:
    sys.stderr.write(f"SET_CAMERA: {msg}\n")
    sys.stderr.flush()


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ae', type=int, required=True, choices=[0, 1],
                        help='Auto-exposure: 0=off, 1=on')
    parser.add_argument('--exposure', type=int, required=True,
                        help='Exposure value (0-32767)')
    parser.add_argument('--gain', type=int, required=True,
                        help='Gain value (within hardware range)')
    args = parser.parse_args()

    services_dir = os.path.dirname(os.path.abspath(__file__))

    if hasattr(os, 'add_dll_directory'):
        try:
            os.add_dll_directory(services_dir)
            log("added services/ to DLL search path")
        except Exception as e:
            log(f"add_dll_directory failed: {e}")

    try:
        hr = ctypes.windll.ole32.CoInitializeEx(None, 0x2)
        log(f"CoInitializeEx hr=0x{hr & 0xFFFFFFFF:08X}")
    except Exception as e:
        log(f"CoInitializeEx failed (non-fatal): {e}")

    dll_path = os.path.join(services_dir, 'DNX64.dll')
    if not os.path.exists(dll_path):
        emit({"ok": False, "error": "DNX64.dll not found in services/"})
        return

    api_path = os.path.join(services_dir, 'DNX64_api.py')
    if not os.path.exists(api_path):
        emit({"ok": False, "error": "DNX64_api.py not found in services/"})
        return

    try:
        spec = importlib.util.spec_from_file_location("DNX64_api", api_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        DNX64 = mod.DNX64
        log("DNX64_api wrapper loaded")
    except Exception as e:
        emit({"ok": False, "error": f"Failed to load API wrapper: {e}"})
        return

    try:
        scope = DNX64(dll_path)
        log("DLL loaded")
    except Exception as e:
        emit({"ok": False, "error": f"Failed to load DNX64.dll: {e}"})
        return

    try:
        log("SetVideoDeviceIndex(0)")
        scope.SetVideoDeviceIndex(0)
        time.sleep(0.1)

        log("Init()...")
        ok = scope.Init()
        log(f"Init() = {ok}")
        if not ok:
            emit({"ok": False, "error": "Microscope not detected. Is it plugged in and not claimed by DinoCapture?"})
            return

        log(f"SetAutoExposure(0, {args.ae})")
        scope.SetAutoExposure(0, args.ae)

        if args.ae == 0:
            log(f"SetExposureValue(0, {args.exposure})")
            scope.SetExposureValue(0, args.exposure)
            log(f"SetVideoProcAmp(9, {args.gain})  [gain]")
            scope.SetVideoProcAmp(9, args.gain)

        emit({"ok": True})

    except Exception as e:
        emit({"ok": False, "error": f"Error setting camera state: {e}"})


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
```

- [ ] **Step 2: Smoke-test the script manually**

With the microscope plugged in, test enabling auto-exposure:

```bash
py services/set_camera.py --ae 1 --exposure 500 --gain 50
```

Expected stdout: `{"ok": true}`

Then test disabling auto-exposure and setting manual values:

```bash
py services/set_camera.py --ae 0 --exposure 1000 --gain 80
```

Expected stdout: `{"ok": true}`

Check the live camera feed (via the existing MicroScan Pro UI) to confirm the image brightness changed.

- [ ] **Step 3: Commit**

```bash
git add services/set_camera.py
git commit -m "feat: add set_camera.py to write exposure/gain via DNX64"
```

---

## Task 3: Express routes

**Files:**
- Modify: `server.ts` — add two routes after the existing `/api/microscope/amr` route (around line 141)

- [ ] **Step 1: Add both routes to `server.ts`**

Open `server.ts`. Locate the closing `});` of the `/api/microscope/amr` route (around line 140). Insert the following two route handlers immediately after it:

```typescript
  // -------------------------------------------------------------------------
  // Camera controls — read state
  // -------------------------------------------------------------------------
  app.get("/api/microscope/camera", (req, res) => {
    if (!pythonExec) {
      return res.status(500).json({ ok: false, error: "Python not available" });
    }
    const scriptPath = path.join(process.cwd(), "services", "get_camera_state.py");
    const proc = spawn(pythonExec, [scriptPath]);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      process.stderr.write(chunk);
    });

    const timer = setTimeout(() => {
      console.warn("[CAMERA] get_camera_state.py timed out after 15s");
      proc.kill();
      if (!res.headersSent) {
        res.status(504).json({ ok: false, error: "Camera state query timed out" });
      }
    }, 15000);

    proc.on("close", () => {
      clearTimeout(timer);
      if (res.headersSent) return;
      const jsonLine = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{") && l.endsWith("}"))
        .pop();
      if (jsonLine) {
        try { res.json(JSON.parse(jsonLine)); return; } catch { /* fall through */ }
      }
      res.status(500).json({
        ok: false,
        error: stderr.trim().split("\n").pop() || "Invalid response from get_camera_state.py",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Camera controls — apply settings
  // -------------------------------------------------------------------------
  app.post("/api/microscope/camera", (req, res) => {
    if (!pythonExec) {
      return res.status(500).json({ ok: false, error: "Python not available" });
    }
    const { autoExposure, exposure, gain } = req.body as {
      autoExposure: boolean;
      exposure: number;
      gain: number;
    };
    if (typeof autoExposure !== "boolean" || typeof exposure !== "number" || typeof gain !== "number") {
      return res.status(400).json({ ok: false, error: "Invalid parameters: expected { autoExposure: boolean, exposure: number, gain: number }" });
    }

    const scriptPath = path.join(process.cwd(), "services", "set_camera.py");
    const proc = spawn(pythonExec, [
      scriptPath,
      "--ae", autoExposure ? "1" : "0",
      "--exposure", String(Math.round(exposure)),
      "--gain", String(Math.round(gain)),
    ]);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      process.stderr.write(chunk);
    });

    const timer = setTimeout(() => {
      console.warn("[CAMERA] set_camera.py timed out after 15s");
      proc.kill();
      if (!res.headersSent) {
        res.status(504).json({ ok: false, error: "Camera set timed out" });
      }
    }, 15000);

    proc.on("close", () => {
      clearTimeout(timer);
      if (res.headersSent) return;
      const jsonLine = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{") && l.endsWith("}"))
        .pop();
      if (jsonLine) {
        try { res.json(JSON.parse(jsonLine)); return; } catch { /* fall through */ }
      }
      res.status(500).json({
        ok: false,
        error: stderr.trim().split("\n").pop() || "Invalid response from set_camera.py",
      });
    });
  });
```

- [ ] **Step 2: Test the routes with curl**

Start the server (`npm run dev`), then in a separate terminal:

```bash
# Read camera state
curl http://localhost:3000/api/microscope/camera
```

Expected: `{"ok":true,"autoExposure":true,"exposure":...,"exposureMin":0,"exposureMax":32767,"gain":...,"gainMin":...,"gainMax":...}`

```bash
# Apply settings (manual, exposure=2000, gain=64)
curl -X POST http://localhost:3000/api/microscope/camera \
  -H "Content-Type: application/json" \
  -d "{\"autoExposure\":false,\"exposure\":2000,\"gain\":64}"
```

Expected: `{"ok":true}`

- [ ] **Step 3: Commit**

```bash
git add server.ts
git commit -m "feat: add GET/POST /api/microscope/camera routes to server.ts"
```

---

## Task 4: React state and camera controls panel

**Files:**
- Modify: `App.tsx`

This task is split into two steps: state + fetch helpers first, then the JSX panel.

### Step group A — state and fetch helpers

- [ ] **Step 1: Add the `CameraControlState` type near the top of `App.tsx`**

After the existing imports, add this interface (before the `type QueueItem = ...` declaration):

```typescript
interface CameraControlState {
  autoExposure: boolean;
  exposure: number;
  exposureMin: number;
  exposureMax: number;
  gain: number;
  gainMin: number;
  gainMax: number;
}
```

- [ ] **Step 2: Add camera control state inside the `App` component**

Find the block of `useState` declarations (around line 107 where `const [currentZ, setCurrentZ]` is). Add the following new state declarations in that block:

```typescript
  const [cameraControlsOpen, setCameraControlsOpen] = useState(false);
  const [cameraState, setCameraState] = useState<CameraControlState | null>(null);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [cameraApplying, setCameraApplying] = useState(false);
  const [cameraApplyResult, setCameraApplyResult] = useState<'ok' | 'error' | null>(null);
  const cameraInFlightRef = useRef(false);
```

- [ ] **Step 3: Add the `fetchCameraState` helper after `startCamera`**

Find the `startCamera` callback (around line 275). Insert the following two callbacks immediately after the closing of `startCamera`:

```typescript
  const fetchCameraState = useCallback(async () => {
    if (cameraInFlightRef.current) return;
    cameraInFlightRef.current = true;
    setCameraLoading(true);
    try {
      const res = await fetch('/api/microscope/camera');
      const data = await res.json();
      if (data.ok) {
        setCameraState(data as CameraControlState & { ok: true });
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
          exposure: cameraState.exposure,
          gain: cameraState.gain,
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
```

- [ ] **Step 4: Add a `useEffect` to fetch camera state when the panel first opens**

Find the `useEffect` for `startCamera` (around line 300). Add the following effect immediately after it:

```typescript
  useEffect(() => {
    if (cameraControlsOpen && cameraState === null && !cameraLoading) {
      fetchCameraState();
    }
  }, [cameraControlsOpen, cameraState, cameraLoading, fetchCameraState]);
```

### Step group B — the overlay panel JSX

- [ ] **Step 5: Add the camera controls panel inside the floating video feed**

Find this block inside the `{showCamera ? (` branch of the Floating Microscope Feed (around line 697):

```tsx
             <div className="absolute top-6 right-6 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={startCamera} className="p-3 bg-black/60 rounded-full text-white hover:bg-cyan-500 hover:text-slate-900 transition-all backdrop-blur-md border border-white/10"><RefreshCw className="w-4 h-4" /></button>
                <button onClick={() => setShowCamera(false)} className="p-3 bg-black/60 rounded-full text-white hover:bg-black transition-colors backdrop-blur-md border border-white/10"><ChevronDown className="w-4 h-4" /></button>
             </div>
```

Replace it with:

```tsx
             {/* Camera Controls — always-visible toggle + collapsible panel */}
             <div className="absolute top-6 right-6 flex flex-col items-end gap-2">
               {/* Hover-only utility buttons */}
               <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                 <button onClick={startCamera} className="p-3 bg-black/60 rounded-full text-white hover:bg-cyan-500 hover:text-slate-900 transition-all backdrop-blur-md border border-white/10"><RefreshCw className="w-4 h-4" /></button>
                 <button onClick={() => setShowCamera(false)} className="p-3 bg-black/60 rounded-full text-white hover:bg-black transition-colors backdrop-blur-md border border-white/10"><ChevronDown className="w-4 h-4" /></button>
               </div>

               {/* Always-visible camera controls toggle */}
               <button
                 onClick={() => setCameraControlsOpen(v => !v)}
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
                         {cameraApplying && <Loader2 className="w-3 h-3 animate-spin" />}
                         {cameraApplyResult === 'ok' && 'Applied ✓'}
                         {cameraApplyResult === 'error' && 'Error ✗'}
                         {!cameraApplying && cameraApplyResult === null && 'Apply'}
                       </button>
                     </>
                   )}
                 </div>
               )}
             </div>
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd "C:\Users\jonah\Downloads\Microscan-Pro-main\Microscan-Pro-main"
npx tsc --noEmit
```

Expected: no errors. If there are type errors, fix them before committing.

- [ ] **Step 7: Start the dev server and test the UI**

```bash
npm run dev
```

Open http://localhost:3000. With the microscope plugged in:

1. The floating camera feed should be visible bottom-right
2. A small "CAM" pill button should appear at the top-right of the video (always visible)
3. Click it — the panel expands and shows a spinner while reading from hardware (~2s)
4. Slider values populate from real hardware state
5. Drag the Gain slider, click Apply — spinner for ~2s, then "Applied ✓"
6. Toggle Auto Exposure ON — Shutter Speed and Gain sliders grey out
7. Click Apply — confirm auto-exposure toggles on the live image
8. Collapse the panel — click the CAM button again; panel closes, values preserved
9. Re-open the panel — no re-read (cached state reused)

Without a microscope: the panel should show "Could not read microscope state" with a Retry link.

- [ ] **Step 8: Commit**

```bash
git add App.tsx
git commit -m "feat: add collapsible camera controls overlay (exposure/gain/auto-AE)"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task covering it |
|-----------------|-----------------|
| `get_camera_state.py` reads AE, exposure, gain, ranges | Task 1 |
| `set_camera.py` writes AE, exposure, gain via CLI args | Task 2 |
| `GET /api/microscope/camera` route | Task 3 |
| `POST /api/microscope/camera` route | Task 3 |
| Read hardware state on first panel open | Task 4, Step 4 (useEffect) |
| Collapsible overlay panel on video feed | Task 4, Step 5 |
| Auto-exposure toggle disables sliders | Task 4, Step 5 (opacity-40 + pointer-events-none) |
| Apply button with spinner + result badge | Task 4, Step 5 |
| Error state with Retry button | Task 4, Step 5 |
| In-flight guard prevents concurrent calls | Task 4, Step 3 (cameraInFlightRef) |
| `os._exit(0)` in both Python scripts | Tasks 1 & 2 |
| 15s timeout on both routes | Task 3 |

**No placeholders found.**

**Type consistency:** `CameraControlState` is defined in Task 4 Step 1 and used consistently in `fetchCameraState`, `applyCameraSettings`, and JSX in Step 5. `setCameraState` always receives `CameraControlState | null`. `cameraApplyResult` is `'ok' | 'error' | null` throughout.
