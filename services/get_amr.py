#!/usr/bin/env python3
"""
Query the Dino-Lite microscope for its current magnification via the AMR
(Automatic Magnification Reading) hardware sensor.

Prints a single JSON line to stdout and exits.  Used by the MicroScan Pro
Express server at GET /api/microscope/amr.

Diagnostic messages are written to stderr so the server can log them
without corrupting the JSON stdout channel.
"""
import os, sys, json, time, importlib.util, ctypes


def log(msg: str) -> None:
    sys.stderr.write(f"GET_AMR: {msg}\n")
    sys.stderr.flush()


def emit(payload: dict) -> None:
    """Print exactly one JSON line to stdout and exit."""
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

    if os.name == 'nt':
        try:
            hr = ctypes.windll.ole32.CoInitializeEx(None, 0x2)
            log(f"CoInitializeEx hr=0x{hr & 0xFFFFFFFF:08X}")
        except Exception as e:
            log(f"CoInitializeEx failed (non-fatal): {e}")

    dll_path = find_matching_dll(services_dir, bitness)
    if not dll_path:
        # Fallback to defaults if scan fails
        dll_name = 'DNX64.dll' if bitness == 64 else 'DNX32.dll'
        dll_path = os.path.join(services_dir, dll_name)
    
    log(f"Selected DLL: {os.path.basename(dll_path)}")

    if not os.path.exists(dll_path):
        emit({"supported": False, "error": f"{os.path.basename(dll_path)} not found in services/"})
        return

    api_path = os.path.join(services_dir, 'DNX64_api.py')
    if not os.path.exists(api_path):
        emit({"supported": False, "error": "DNX64_api.py not found in services/"})
        return

    # Dynamically load the API wrapper so we don't need it on sys.path
    try:
        spec = importlib.util.spec_from_file_location("DNX64_api", api_path)
        mod  = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        DNX64 = mod.DNX64
        log("DNX64_api wrapper loaded")
    except Exception as e:
        emit({"supported": False, "error": f"Failed to load API wrapper: {e}"})
        return

    try:
        t0 = time.time()
        scope = DNX64(dll_path)
        log(f"DLL + signatures loaded in {time.time()-t0:.2f}s")
    except OSError as e:
        emit({"supported": False, "error": f"Failed to load DNX64.dll: {e}"})
        return
    except Exception as e:
        emit({"supported": False, "error": f"DLL init error: {e}"})
        return

    try:
        log("calling GetVideoDeviceCount()…")
        count = scope.GetVideoDeviceCount()
        log(f"Detected {count} video devices")
        
        log("calling SetVideoDeviceIndex(0)…")
        scope.SetVideoDeviceIndex(0)
        time.sleep(0.1)

        log("calling Init()…")
        t0 = time.time()
        ok = scope.Init()
        log(f"Init() returned {ok} in {time.time()-t0:.2f}s")
        if not ok:
            emit({"supported": False,
                   "error": "Microscope not detected. Is it plugged in and not claimed by DinoCapture?"})
            return

        # GetConfig bit 0x40 → AMR feature present
        log("calling GetConfig(0)…")
        config = scope.GetConfig(0)
        log(f"GetConfig = 0x{config:X}")
        if not (config & 0x40):
            emit({
                "supported": False,
                "error": "This Dino-Lite model does not have the AMR feature",
                "config": hex(config)
            })
            return

        log("calling GetAMR(0)…")
        amr = float(scope.GetAMR(0))
        log(f"AMR = {amr}")

        log("calling FOVx(0, amr)…")
        fov_um = float(scope.FOVx(0, amr))
        log(f"FOV = {fov_um} um")

        emit({
            "supported":     True,
            "magnification": round(amr,    1),
            "fovXUm":        round(fov_um, 2)
        })

    except Exception as e:
        emit({"supported": False, "error": f"Error reading microscope: {e}"})


if __name__ == "__main__":
    main()
    # The DNX64 DLL leaves background threads running (USB polling, etc.) that
    # would otherwise keep the Python process alive indefinitely after main()
    # returns, causing the parent (Node) to never see the 'close' event.
    # Force an immediate exit now that we've printed our JSON result.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
