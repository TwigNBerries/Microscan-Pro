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

    # Detect architecture bitness and choose correct DLL
    import struct
    bitness = 8 * struct.calcsize('P')
    dll_name = 'DNX64.dll' if bitness == 64 else 'DNX32.dll'
    dll_path = os.path.join(services_dir, dll_name)
    log(f"Running in {bitness}-bit Python, using {dll_name}")

    if not os.path.exists(dll_path):
        emit({"ok": False, "error": f"{dll_name} not found in services/"})
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
        log("GetVideoDeviceCount()")
        count = scope.GetVideoDeviceCount()
        log(f"Detected {count} video devices")

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

        log(f"calling SetAutoExposure(0, {args.ae})")
        scope.SetAutoExposure(0, args.ae)

        if args.ae == 0:
            log(f"calling SetExposureValue(0, {args.exposure})")
            scope.SetExposureValue(0, args.exposure)
            log(f"calling SetVideoProcAmp(9, {args.gain})  [gain]")
            scope.SetVideoProcAmp(9, args.gain)

        # ok: true means the SDK calls were issued without exception.
        # It does not confirm hardware state changed — there is no read-back.
        emit({"ok": True})

    except Exception as e:
        emit({"ok": False, "error": f"Error setting camera state: {e}"})


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
