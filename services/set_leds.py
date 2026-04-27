#!/usr/bin/env python3
"""
Apply Dino-Lite LED settings via the DNX64 SDK.  Used by POST /api/microscope/leds.

CLI args (all optional individually; at least one must be provided):
    --flc-level    <1..6>             FLC global brightness (SetFLCLevel)
    --flc-switch   <1..15 | 16>       FLC quadrant bitmask (1=Q1, 2=Q2, 4=Q3,
                                      8=Q4, 16=all off)
    --eflc         "Q,V"              Per-quadrant eFLC (EdgePLUS): Q in 1..4
                                      (0 = all four), V in 1..31 (32 = off).
                                      May be repeated for several quadrants.
    --led-state    <int>              Generic SetLEDState — see SDK appendix.

Prints one JSON line and exits.
"""
import os, sys, json, time, importlib.util, ctypes, argparse


def log(msg: str) -> None:
    sys.stderr.write(f"SET_LEDS: {msg}\n")
    sys.stderr.flush()


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def parse_eflc(val: str):
    """Parse 'Q,V' eflc tuple — returns (quadrant, value)."""
    try:
        q_str, v_str = val.split(',')
        return int(q_str), int(v_str)
    except Exception:
        raise argparse.ArgumentTypeError(f"--eflc expects 'Q,V' format, got {val!r}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--flc-level',  type=int, default=None, dest='flc_level',
                        help='FLC brightness 1..6')
    parser.add_argument('--flc-switch', type=int, default=None, dest='flc_switch',
                        help='FLC quadrant bitmask 1..15, or 16=off')
    parser.add_argument('--eflc',       type=parse_eflc, action='append', default=[],
                        help='Per-quadrant eFLC: Q,V (Q=0..4, V=1..31 or 32=off)')
    parser.add_argument('--led-state',  type=int, default=None, dest='led_state',
                        help='Generic LED state (model-specific bitfield)')
    args = parser.parse_args()

    if (args.flc_level is None and args.flc_switch is None
            and not args.eflc and args.led_state is None):
        emit({"ok": False, "error": "No LED parameters provided"})
        return

    # Range validation
    if args.flc_level is not None and not (1 <= args.flc_level <= 6):
        emit({"ok": False, "error": f"flc-level {args.flc_level} out of range 1..6"})
        return
    if args.flc_switch is not None and not (1 <= args.flc_switch <= 16):
        emit({"ok": False, "error": f"flc-switch {args.flc_switch} out of range 1..16"})
        return
    for q, v in args.eflc:
        if not (0 <= q <= 4):
            emit({"ok": False, "error": f"eflc quadrant {q} out of range 0..4"})
            return
        if not (1 <= v <= 32):
            emit({"ok": False, "error": f"eflc value {v} out of range 1..32"})
            return

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

        # Apply level FIRST so the brightness is in effect before quadrants
        # turn on (otherwise users see a brief stale-brightness flash).
        if args.flc_level is not None:
            log(f"calling SetFLCLevel(0, {args.flc_level})")
            scope.SetFLCLevel(0, args.flc_level)

        if args.flc_switch is not None:
            log(f"calling SetFLCSwitch(0, {args.flc_switch})")
            scope.SetFLCSwitch(0, args.flc_switch)

        eflc_results = []
        for q, v in args.eflc:
            log(f"calling SetEFLC(0, {q}, {v})")
            try:
                scope.SetEFLC(0, q, v)
                eflc_results.append({"quadrant": q, "value": v, "ok": True})
            except Exception as e:
                # On non-EdgePLUS scopes SetEFLC may throw — record but continue.
                log(f"SetEFLC failed (likely non-EdgePLUS): {e}")
                eflc_results.append({"quadrant": q, "value": v, "ok": False, "error": str(e)})

        if args.led_state is not None:
            log(f"calling SetLEDState(0, {args.led_state})")
            scope.SetLEDState(0, args.led_state)

        emit({
            "ok": True,
            "eflcResults": eflc_results if eflc_results else None,
        })

    except Exception as e:
        emit({"ok": False, "error": f"Error setting LEDs: {e}"})


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
