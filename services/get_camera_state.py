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


def find_matching_dll(services_dir, target_bitness):
    """Scan services dir for a DLL matching the target bitness (32 or 64)."""
    import os, struct
    for f in os.listdir(services_dir):
        if f.lower().endswith('.dll') and f.lower().startswith('dnx'):
            path = os.path.join(services_dir, f)
            try:
                with open(path, 'rb') as fd:
                    header = fd.read(4096)
                    if header[:2] == b'MZ':
                        pe_offset = struct.unpack('<I', header[0x3C:0x40])[0]
                        machine = struct.unpack('<H', header[pe_offset+4:pe_offset+6])[0]
                        dll_bitness = 32 if machine == 0x014C else 64 if machine == 0x8664 else 0
                        if dll_bitness == target_bitness:
                            return path
            except:
                continue
    return None

def main():
    services_dir = os.path.dirname(os.path.abspath(__file__))
    log(f"services_dir = {services_dir}")

    import struct
    bitness = 8 * struct.calcsize('P')
    log(f"Running in {bitness}-bit Python")

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

    dll_path = find_matching_dll(services_dir, bitness)
    if not dll_path:
        dll_name = 'DNX64.dll' if bitness == 64 else 'DNX32.dll'
        dll_path = os.path.join(services_dir, dll_name)
    
    log(f"Selected DLL: {os.path.basename(dll_path)}")

    if not os.path.exists(dll_path):
        emit({"ok": False, "error": f"{os.path.basename(dll_path)} not found in services/"})
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

        log("calling GetAutoExposure(0)...")
        auto_exposure = int(scope.GetAutoExposure(0))
        log(f"GetAutoExposure = {auto_exposure}")

        log("calling GetExposureValue(0)...")
        exposure = int(scope.GetExposureValue(0))
        log(f"GetExposureValue = {exposure}")

        log("calling GetVideoProcAmp(9) [gain]...")
        gain = int(scope.GetVideoProcAmp(9))
        log(f"GetVideoProcAmp(9) [gain] = {gain}")

        log("calling GetVideoProcAmpValueRange(9)...")
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
