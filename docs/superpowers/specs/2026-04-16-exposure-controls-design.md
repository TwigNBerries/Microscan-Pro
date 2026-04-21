# Exposure Controls Design
_Date: 2026-04-16_

## Summary

Add a collapsible camera-control overlay panel to the live video feed in MicroScan Pro. The panel exposes three hardware controls for the Dino-Lite microscope: an auto-exposure toggle, a shutter speed (exposure) slider, and a gain slider. Controls are read from hardware on panel open and written via an explicit Apply button.

---

## Architecture

### Backend — two new Python scripts

**`services/get_camera_state.py`**
- Follows the exact pattern of `get_amr.py`: spawned fresh per request, calls `Init()`, reads hardware state, emits one JSON line to stdout, calls `os._exit(0)`
- Calls in one `Init()` session:
  - `GetAutoExposure(0)` → `autoExposure: 0|1`
  - `GetExposureValue(0)` → `exposure: int`
  - `GetVideoProcAmp(9)` → `gain: int` (index 9 = DirectShow Gain)
  - `GetVideoProcAmpValueRange(9)` → `gainMin, gainMax, gainStep, gainDefault`
  - Exposure range: `GetExposureValue` has no companion range-query method in the SDK wrapper. The script will use hardcoded fallback bounds (`exposureMin=0`, `exposureMax=32767`) which cover the full documented DNX64 range. These can be tightened once confirmed against the PDF appendix.
- Output JSON: `{ ok: true, autoExposure: bool, exposure: int, exposureMin: int, exposureMax: int, gain: int, gainMin: int, gainMax: int }`
- On any failure: `{ ok: false, error: string }`

**`services/set_camera.py`**
- Accepts CLI args: `--ae 0|1 --exposure INT --gain INT`
- Same Init() + `os._exit(0)` pattern
- Calls `SetAutoExposure(0, ae)`
- If `ae == 0`: also calls `SetExposureValue(0, exposure)` and `SetVideoProcAmp(9, gain)`
- Output JSON: `{ ok: true }` or `{ ok: false, error: string }`

> Note: The per-spawn approach is used because it is proven to work with the DNX64 DLL's caching behaviour. If a faster method (daemon, persistent IPC, etc.) becomes viable it can replace these scripts without changing the API contract.

### Backend — two new Express routes in `server.ts`

| Method | Path | Script | Purpose |
|--------|------|--------|---------|
| `GET` | `/api/microscope/camera` | `get_camera_state.py` | Read current hardware state |
| `POST` | `/api/microscope/camera` | `set_camera.py` | Apply new values |

Both routes follow the same spawn/timeout/stdout-parse pattern as `/api/microscope/amr`. Timeout: 15 s. In-flight guard on the frontend prevents concurrent calls.

---

## Frontend

### New state (added to `App.tsx`)

```ts
cameraControlsOpen: boolean                          // panel collapsed/expanded
cameraState: {
  autoExposure: boolean
  exposure: number
  exposureMin: number
  exposureMax: number
  gain: number
  gainMin: number
  gainMax: number
} | null                                             // null = not yet loaded
cameraLoading: boolean                               // GET in-flight
cameraApplying: boolean                              // POST in-flight
cameraApplyResult: 'ok' | 'error' | null            // cleared after 2 s
```

### UI — collapsible overlay panel

**Toggle button**: small button anchored to the top-right corner of the live video feed area. Always visible. Shows a camera icon + chevron. Chevron rotates when panel is open.

**Expanded panel** (`bg-slate-900/80 backdrop-blur-xl`, rounded corners, border):

1. **Header row**: "Camera Controls" label + close chevron
2. **Loading state**: spinner shown while `GET /api/microscope/camera` is in-flight on first open
3. **Auto-Exposure toggle**: pill toggle (same style as existing toggles). Label: "Auto Exposure". When ON, sliders below are disabled and visually dimmed.
4. **Exposure slider**: label "Shutter Speed", range `[exposureMin, exposureMax]`, current numeric value shown to the right. Disabled when auto-exposure is ON.
5. **Gain slider**: label "Gain", range `[gainMin, gainMax]`, current value shown to the right. Disabled when auto-exposure is ON.
6. **Apply button**: full-width, cyan. Disabled while `cameraApplying`. Shows spinner during write. After completion shows "Applied ✓" (green) or "Error ✗" (red) for 2 s then clears.

**Behaviour**:
- Panel open triggers `GET /api/microscope/camera` only on the first open (or if `cameraState` is null). Subsequent opens reuse cached state.
- Apply fires `POST /api/microscope/camera` with current slider values. In-flight guard prevents concurrent POSTs.
- Slider values are preserved in React state while the component is mounted; panel collapse does not reset them.
- The panel does not poll — it is read-on-open, write-on-apply only.

---

## Error Handling

- If `GET` fails: panel shows "Could not read microscope state" with a Retry button (re-fires the GET).
- If `POST` fails: Apply button shows "Error ✗" badge for 2 s; sliders remain at their current positions so the user can retry.
- If Python/DLL not available: both routes return `{ ok: false, error: "..." }` and the panel shows the error string.

---

## Out of Scope

- Real-time slider preview (no live-send on drag)
- Persisting exposure settings across sessions
- Any other VideoProcAmp properties (brightness, contrast, etc.)
