#!/usr/bin/env python3
"""
Write auto-exposure / Luma (AETarget) / ISO to the Dino-Lite microscope
via the DNX64 SDK.  Used by POST /api/microscope/exposure.

CLI args (all optional individually; at least one must be provided):
    --ae         0|1                  Auto-exposure off/on
    --aetarget   <16..220>            Luma target (only meaningful when AE on)
    --iso-raw    <0..140>             Raw ISO (EdgePLUS only).  Server passes
                                      the *raw* value, not the mapped 100..12800
                                      ISO; mapping is done client-side.

Prints one JSON line and exits.
"""
import os, sys, json, time, importlib.util, ctypes, argparse


def log(msg: str) -> None:
    sys.stderr.write(f"SET_EXPOSURE: {msg}\n")
    sys.stderr.flush()


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ae',       type=int, choices=[0, 1], default=None,
                        help='Auto-exposure: 0=off, 1=on')
    parser.add_argument('--aetarget', type=int, default=None,
                        help='Luma (AE target) value, 16..220')
    parser.add_argument('--iso-raw',  type=int, default=None, dest='iso_raw',
                        help='Raw ISO value, 0..140 (EdgePLUS only)')
    args = parser.parse_args()

    if args.ae is None and args.aetarget is None and args.iso_raw is None:
        emit({"ok": False, "error": "No exposure parameters provided"})
        return

    # Validate ranges (the DLL silently clamps/rejects out-of-range values, so
    # catch obvious mistakes here for clearer error reporting).
    if args.aetarget is not None and not (16 <= args.aetarget <= 220):
        emit({"ok": False, "error": f"aetarget {args.aetarget} out of range 16..220"})
        return
    if args.iso_raw is not None and not (0 <= args.iso_raw <= 140):
        emit({"ok": False, "error": f"iso-raw {args.iso_raw} out of range 0..140"})
        return

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
    except OSError as e:
        emit({"ok": False, "error": f"Failed to load DNX64.dll: {e}"})
        return
    except Exception as e:
        emit({"ok": False, "error": f"DLL init error: {e}"})
        return

    iso_applied = None
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

        if args.ae is not None:
            log(f"calling SetAutoExposure(0, {args.ae})")
            scope.SetAutoExposure(0, args.ae)

        if args.aetarget is not None:
            log(f"calling SetAETarget(0, {args.aetarget}) [Luma]")
            scope.SetAETarget(0, args.aetarget)

        if args.iso_raw is not None:
            log(f"calling SetISO(0, {args.iso_raw})")
            try:
                scope.SetISO(0, args.iso_raw)
                iso_applied = True
            except Exception as e:
                # On non-EdgePLUS scopes the DLL may throw — fall back gracefully.
                log(f"SetISO failed (likely non-EdgePLUS): {e}")
                iso_applied = False

        emit({
            "ok": True,
            "isoApplied": iso_applied,  # null = not requested, true/false = result
        })

    except Exception as e:
        emit({"ok": False, "error": f"Error setting exposure: {e}"})


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
