#!/usr/bin/env python3
"""
Probe Dino-Lite LED capabilities via GetConfig / GetLEDConfig.

The DNX64 SDK exposes setters for FLC level / switch / EFLC, but does NOT
expose getters for the current LED state — so this script only reports what
the hardware *supports*.  The UI is responsible for owning the local state
(brightness, active quadrants) since there's no way to read it back.

GetConfig bits we care about (from the SDK appendix):
    bit 0 (0x01) = AXI lighting
    bit 1 (0x02) = FLC (Flexible LED Control: 4 quadrants, single brightness)
    bit 5 (0x20) = eFLC (per-quadrant brightness, EdgePLUS)
    bit 6 (0x40) = AMR (already used elsewhere)

Used by GET /api/microscope/leds.
"""
import os, sys, json, time, importlib.util, ctypes


def log(msg: str) -> None:
    sys.stderr.write(f"GET_LEDS: {msg}\n")
    sys.stderr.flush()


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def main():
    services_dir = os.path.dirname(os.path.abspath(__file__))

    if hasattr(os, 'add_dll_directory'):
        try:
            os.add_dll_directory(services_dir)
        except Exception as e:
            log(f"add_dll_directory failed: {e}")

    try:
        ctypes.windll.ole32.CoInitializeEx(None, 0x2)
    except Exception as e:
        log(f"CoInitializeEx failed (non-fatal): {e}")

    dll_path = os.path.join(services_dir, 'DNX64.dll')
    api_path = os.path.join(services_dir, 'DNX64_api.py')
    if not os.path.exists(dll_path) or not os.path.exists(api_path):
        emit({"ok": False, "error": "DNX64 SDK files missing in services/"})
        return

    try:
        spec = importlib.util.spec_from_file_location("DNX64_api", api_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        DNX64 = mod.DNX64
    except Exception as e:
        emit({"ok": False, "error": f"Failed to load API wrapper: {e}"})
        return

    try:
        scope = DNX64(dll_path)
    except Exception as e:
        emit({"ok": False, "error": f"DLL load error: {e}"})
        return

    try:
        scope.SetVideoDeviceIndex(0)
        time.sleep(0.1)

        log("Init()...")
        t0 = time.time()
        ok = scope.Init()
        log(f"Init() returned {ok} in {time.time()-t0:.2f}s")
        if not ok:
            emit({"ok": False, "error": "Microscope not detected. Is it plugged in and not claimed by DinoCapture?"})
            return

        config = int(scope.GetConfig(0))
        log(f"GetConfig = 0x{config:X}")

        led_config = 0
        try:
            led_config = int(scope.GetLEDConfig(0))
            log(f"GetLEDConfig = 0x{led_config:X}")
        except Exception as e:
            log(f"GetLEDConfig failed (non-fatal): {e}")

        flc_supported  = bool(config & 0x02)
        eflc_supported = bool(config & 0x20)
        axi_supported  = bool(config & 0x01)

        emit({
            "ok":             True,
            "config":         hex(config),
            "ledConfig":      hex(led_config),
            "flcSupported":   flc_supported,
            "eflcSupported":  eflc_supported,
            "axiSupported":   axi_supported,
            # Setter ranges, surfaced for the UI:
            "flcLevelMin":    1,
            "flcLevelMax":    6,
            "flcSwitchOff":   16,            # SetFLCSwitch(16) = all quadrants off
            "flcSwitchAll":   15,            # bitmask 1111 = all four quadrants on
            "eflcQuadrants":  4,
            "eflcValueMin":   1,
            "eflcValueMax":   31,
            "eflcValueOff":   32,            # SetEFLC value 32 = quadrant off
        })

    except Exception as e:
        emit({"ok": False, "error": f"Error probing LED capabilities: {e}"})


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
