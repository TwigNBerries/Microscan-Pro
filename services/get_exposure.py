#!/usr/bin/env python3
"""
Read auto-exposure / Luma (AETarget) / ISO state from the Dino-Lite microscope
via the DNX64 SDK.

Mapping back to DinoCapture UI labels:
   AE On/Off     -> GetAutoExposure / SetAutoExposure
   Luma          -> GetAETarget     / SetAETarget       (range 16..220)
   ISOmax        -> GetISO          / SetISO            (raw 0..140)
                    real ISO = 100 * 2^(raw/20)         (EdgePLUS only)

Prints one JSON line to stdout and exits.  Used by GET /api/microscope/exposure.
"""
import os, sys, json, time, importlib.util, ctypes


def log(msg: str) -> None:
    sys.stderr.write(f"GET_EXPOSURE: {msg}\n")
    sys.stderr.flush()


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


# Discrete ISO stops the SDK exposes through SetISO.  Value = 100 * 2^(raw/20).
ISO_STOPS = [
    (0,   100),
    (20,  200),
    (40,  400),
    (60,  800),
    (80,  1600),
    (100, 3200),
    (120, 6400),
    (140, 12800),
]


def iso_from_raw(raw: int) -> int:
    """Map raw 0..140 to nearest ISO stop value."""
    closest = min(ISO_STOPS, key=lambda p: abs(p[0] - raw))
    return closest[1]


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
        t0 = time.time()
        scope = DNX64(dll_path)
        log(f"DLL + signatures loaded in {time.time()-t0:.2f}s")
    except OSError as e:
        emit({"ok": False, "error": f"Failed to load DNX64.dll: {e}"})
        return
    except Exception as e:
        emit({"ok": False, "error": f"DLL init error: {e}"})
        return

    try:
        log("SetVideoDeviceIndex(0)")
        scope.SetVideoDeviceIndex(0)
        time.sleep(0.1)

        log("Init()...")
        t0 = time.time()
        ok = scope.Init()
        log(f"Init() returned {ok} in {time.time()-t0:.2f}s")
        if not ok:
            emit({"ok": False, "error": "Microscope not detected. Is it plugged in and not claimed by DinoCapture?"})
            return

        log("calling GetAutoExposure(0)...")
        ae = int(scope.GetAutoExposure(0))
        log(f"GetAutoExposure = {ae}")

        log("calling GetAETarget(0)...")
        ae_target = int(scope.GetAETarget(0))
        log(f"GetAETarget [Luma] = {ae_target}")

        log("calling GetExposureValue(0)...")
        exposure = int(scope.GetExposureValue(0))
        log(f"GetExposureValue = {exposure}")

        # Runtime ISO support probe — there's no GetConfig bit for ISO, so we
        # call GetISO and treat any sane response as proof of EdgePLUS support.
        iso_supported = False
        iso_raw = 0
        iso_value = 100
        try:
            log("calling GetISO(0)...")
            iso_raw_val = int(scope.GetISO(0))
            log(f"GetISO = {iso_raw_val}")
            # EdgePLUS hardware returns 0..140; non-EdgePLUS often returns 0
            # or some sentinel.  Accept anything in the documented range.
            if 0 <= iso_raw_val <= 140:
                iso_supported = True
                iso_raw = iso_raw_val
                iso_value = iso_from_raw(iso_raw_val)
        except Exception as e:
            log(f"GetISO unsupported / failed: {e}")

        emit({
            "ok":            True,
            "autoExposure":  bool(ae),
            "exposure":      exposure,
            "exposureMin":   0,
            "exposureMax":   32767,
            # Luma (AE target) — 16..220, only meaningful when AE is on.
            "aeTarget":      ae_target,
            "aeTargetMin":   16,
            "aeTargetMax":   220,
            # ISO — EdgePLUS only.  Raw 0..140 maps to {100..12800}.
            "isoSupported":  iso_supported,
            "isoRaw":        iso_raw,
            "iso":           iso_value,
            "isoStops":      [v for _, v in ISO_STOPS],
        })

    except Exception as e:
        emit({"ok": False, "error": f"Error reading exposure state: {e}"})


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
