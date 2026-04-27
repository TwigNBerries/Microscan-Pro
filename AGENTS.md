# MicroScan Pro — Project Context

## Project Overview

**MicroScan Pro** is a full-stack React 19 + TypeScript + Express 5 + Python microscope scanning application for capturing high-resolution depth-stacked mosaic images of microscope samples. It integrates with a Dino-Lite digital microscope via the manufacturer's DNX64 SDK to read live magnification and automate image capture workflows.

**Stack**:
- **Frontend**: React 19, TypeScript, TailwindCSS, Lucide icons
- **Backend**: Express 5, Node.js
- **Hardware Integration**: Python 3.10 + ctypes + Dino-Lite DNX64 SDK (Windows COM/ActiveX)
- **Imaging**: OpenCV (Python), NumPy, SciPy for depth-stacking, stitching, focus detection

## Architecture & Key Components

### Frontend (`App.tsx`, React Components)

- **Serial Communication**: Web Serial API to a 3D printer (for XYZ stage control)
- **Video Feed**: `getUserMedia()` for live microscope preview via USB camera
- **Tab Navigation**: Config, Jog, Manual, Verify, Stacking, Depth, Stitching, Gallery views
- **Magnification Input**: Reads current objective magnification; can be auto-populated from microscope via AMR (Automatic Magnification Reading)
- **Polling Pattern** (AMR):
  - `useEffect` with `setInterval` polling `/api/microscope/amr` every 500 ms (fast) or 5 s (slow)
  - In-flight guard (`amrInFlightRef`) prevents request pile-up
  - Updates `settings.magnification` on change via dedup logic: `setSettings(s => s.magnification !== data.magnification ? {...s, magnification: data.magnification} : s)`
  - UI shows pulsing green "LIVE" badge when AMR is actively reading

### Backend (`server.ts`, Express Routes)

- **Serial/Image Routes**:
  - `POST /api/capture` — capture image from camera
  - `POST /api/stitch` — stitch captured images into mosaic
  - `POST /api/depth` — run focus-stacking depth estimation
  - Serial port bridging for printer commands

- **Microscope AMR Route** (`GET /api/microscope/amr`):
  - **Per-Request Python Spawn**: Each request spawns a fresh `get_amr.py` process
  - **Why per-request?** The Dino-Lite DNX64 DLL caches `GetAMR()` results within a single `Init()` session. The only way to force a fresh hardware read is to re-run `Init()`, which takes ~2 seconds. There is no cheaper refresh API exposed.
  - **Latency**: ~2 s per call (DLL `Init()` overhead)
  - **Error Handling**: 15 s timeout; parses stdout for last `{...}` JSON line (DNX64 prints "U3Open: USB\..." junk to stdout that must be filtered out)

### Python Microscope Integration (`services/get_amr.py`)

Spawned once per `/api/microscope/amr` request:

```python
# Load DNX64.dll via ctypes
# Initialize COM: CoInitializeEx(None, 0x2)  # apartment-threaded
# Set video device index: SetVideoDeviceIndex(0)
# Init: Init()  # ~2 s, brings up USB connection
# Check AMR feature: GetConfig(0) & 0x40 == True
# Read magnification: GetAMR(0)
# Get field-of-view: FOVx(0, amr)
# Force immediate exit: os._exit(0)  # kill background DLL threads
```

**Key Details**:
- **COM Initialization**: `ctypes.windll.ole32.CoInitializeEx(None, 0x2)` for apartment-threaded mode (required for ActiveX)
- **Force Exit**: `os._exit(0)` is critical—the DNX64 DLL spawns background USB polling threads that prevent normal Python exit, causing the Node child process to never see the 'close' event
- **No Daemon Approach**: Earlier attempts to keep a long-running daemon that reused the same `scope` object failed because the DLL caches sensor readings and only refreshes them when `Init()` is called

## File Structure

```
Microscan-Pro-main/
├── App.tsx                    # Main React app, all UI + state
├── server.ts                  # Express backend, routes
├── services/
│   ├── get_amr.py            # Microscope magnification reader (per-request)
│   ├── get_amr_daemon.py      # [UNUSED] Earlier daemon attempt; can be deleted
│   ├── DNX64_api.py           # Wrapper for DNX64.dll (user-provided)
│   ├── DNX64.dll              # Dino-Lite SDK (user-provided)
│   ├── DNX32.dll              # 32-bit variant (user-provided)
│   ├── libusbK.dll            # USB driver library (user-provided)
│   ├── depthService.ts        # Focus-stacking depth estimation
│   └── [other services]
├── components/
│   ├── StitchingView.tsx      # Mosaic display with axis labels & colorbar
│   └── [other UI components]
└── AGENTS.md                  # This file
```

## Recent Work (This Session)

### Problem: Magnification Never Updates After Initial Read
- **Symptom**: Turning the microscope's magnification dial showed no change in the UI after the first startup reading
- **Root Cause**: DNX64 DLL caches `GetAMR()` results within a single `Init()` session. Re-polling the same scope object returns stale values indefinitely.
- **Attempted Solutions**:
  1. Free-running Python daemon (50 ms polling loop) — DLL returned identical cached values
  2. TCP socket IPC (stdin pipe had Windows buffering issues) — then hit same DLL caching issue
- **Final Solution**: Back to per-request spawns. Each `/api/microscope/amr` request forces a fresh `Init()`, which costs ~2 s but guarantees a live reading.

### Changes Made
1. **server.ts**: Reverted AMR endpoint to per-request `get_amr.py` spawn (original working behavior)
2. **App.tsx**:
   - Replaced manual sync button with automatic polling on a timer
   - Fast mode: 500 ms poll interval (effective ~2 s due to in-flight guard + DLL latency)
   - Slow mode: 5 s poll interval (reduces USB load when not adjusting dial)
   - Added in-flight guard to prevent request pile-up
   - Added pulsing "LIVE" badge to magnification label when AMR is active
   - Made input `readOnly` when live (prevents typing while polling)

### Depth Heatmap Enhancements
- **Legend Size**: Scaled proportionally to mosaic dimensions: `fs = Math.max(18, Math.min(48, Math.round(Math.min(mW, mH) / 25)))`
- **Correct Value Range**: Pass Python's `minZ`/`maxZ` (actual mm) instead of Z-stack indices (0-29)
- **Axis Labels**: Added X-axis, Y-axis, Z-axis (colorbar) labels with ticks, computed from physical grid dimensions

## Known Limitations & Caveats

1. **AMR Latency (~2 s)**
   - Each magnification read pays the DLL `Init()` cost
   - This is a hardware limitation; no faster API is exposed by the SDK
   - The in-flight guard ensures we never spawn multiple processes; effective update cadence is ~2 s

2. **Windows-Only**
   - DNX64 SDK uses Windows COM/ActiveX
   - Paths are Windows-specific (`os.add_dll_directory`, `ctypes.windll`)

3. **USB Device Binding**
   - Only one instance of the DNX64 DLL can hold the microscope at a time
   - DinoCapture (the official Dino-Lite app) will conflict if running simultaneously
   - If the microscope is unplugged, the next `Init()` call will fail; polling will retry automatically

## How to Continue

1. **To work on this project in Codex IDE**:
   - Open the project folder in VS Code
   - Open the Codex tab
   - This AGENTS.md will be auto-loaded for context

2. **To test AMR (magnification reading)**:
   - Start the server: `npm run dev`
   - Open http://localhost:3000
   - Navigate to **Config** tab
   - You should see the "Magnification" field with a pulsing "LIVE" badge
   - Turn the microscope's magnification dial; the value should update within ~2 seconds
   - Click the **~2s / ~5s** toggle to switch between continuous and low-impact polling

3. **If AMR stops working**:
   - Check server console for errors in the `GET /api/microscope/amr` endpoint
   - Verify the microscope is plugged in and not claimed by DinoCapture
   - Restart the server; polling will retry indefinitely with exponential backoff

## Next Steps (If Needed)

- **Performance**: Consider caching the magnification reading and only polling when the UI is in focus (`document.hasFocus()`)
- **Error Recovery**: Implement exponential backoff on repeated AMR failures rather than hammering the endpoint
- **FOV Display**: The `fovXUm` value from AMR could be displayed as a secondary metric
- **Daemon Revisit**: If a future SDK update exposes a cheaper refresh call (e.g., `RefreshAMR()` or `PollSensor()`), the daemon model could be revived for sub-second latency
