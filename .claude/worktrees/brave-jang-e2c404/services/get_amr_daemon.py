#!/usr/bin/env python3
"""
AMR daemon — TCP socket IPC.

Loads DNX64.dll once, runs a small TCP server on 127.0.0.1:AMR_DAEMON_PORT.
Each newline-terminated "READ" command over the socket triggers one
GetAMR/FOVx call and a JSON reply, also newline-terminated.

Why TCP instead of stdin/stdout?
    The previous stdin-pipe version hung indefinitely on Windows: Node's
    `proc.stdin.write("READ\n")` bytes never surfaced on the Python side of
    `sys.stdin.readline()`, presumably due to pipe buffering between the
    Node child-process layer and Python's BufferedReader.  Loopback TCP
    bypasses all of that — both ends see each write immediately.

Stdout is still used for exactly two things:
    1. An initial JSON reading, so the UI has a value to display while the
       Node server is still establishing its TCP connection.
    2. A one-line port announcement so Node knows which port we bound.
Stderr carries "AMR_DAEMON: …" diagnostics for the server console.
"""
import os
import sys
import json
import time
import socket
import importlib.util
import ctypes


PORT            = int(os.environ.get('AMR_DAEMON_PORT', '9876'))
RECONNECT_S     = 2.0
MAX_POLL_FAILS  = 5


def log(msg: str) -> None:
    sys.stderr.write(f"AMR_DAEMON: {msg}\n")
    sys.stderr.flush()


def emit(payload: dict) -> None:
    """Write one JSON line to stdout (startup / port announcement only)."""
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def load_api(services_dir: str):
    dll_path = os.path.join(services_dir, 'DNX64.dll')
    api_path = os.path.join(services_dir, 'DNX64_api.py')
    if not os.path.exists(dll_path):
        emit({"supported": False, "error": "DNX64.dll not found in services/"})
        return None, None
    if not os.path.exists(api_path):
        emit({"supported": False, "error": "DNX64_api.py not found in services/"})
        return None, None

    spec = importlib.util.spec_from_file_location("DNX64_api", api_path)
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.DNX64, dll_path


def init_scope(DNX64_cls, dll_path: str):
    try:
        scope = DNX64_cls(dll_path)
    except Exception as e:
        emit({"supported": False, "error": f"Failed to load DNX64.dll: {e}"})
        return None

    try:
        scope.SetVideoDeviceIndex(0)
        time.sleep(0.1)
        t0 = time.time()
        ok = scope.Init()
        log(f"Init() returned {ok} in {time.time()-t0:.2f}s")
        if not ok:
            emit({"supported": False,
                   "error": "Microscope not detected. Is it plugged in and not claimed by DinoCapture?"})
            return None

        config = scope.GetConfig(0)
        log(f"GetConfig = 0x{config:X}")
        if not (config & 0x40):
            emit({"supported": False,
                   "error": "This Dino-Lite model does not have the AMR feature",
                   "config": hex(config)})
            return None
        return scope
    except Exception as e:
        emit({"supported": False, "error": f"Init error: {e}"})
        return None


def read_once(scope) -> dict:
    amr    = float(scope.GetAMR(0))
    fov_um = float(scope.FOVx(0, amr))
    return {
        "supported":     True,
        "magnification": round(amr,    1),
        "fovXUm":        round(fov_um, 2)
    }


def serve_connection(conn: socket.socket, scope, fail_state: list, read_counter: list) -> bool:
    """
    Serve READ commands on one accepted connection.
    Returns True if we should re-init the scope (too many failures), else False.
    """
    conn.settimeout(None)   # block indefinitely on recv
    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    buf = b""
    while True:
        try:
            data = conn.recv(4096)
        except OSError as e:
            log(f"recv error: {e}")
            return False
        if not data:
            log("peer closed connection")
            return False
        buf += data

        # Process every complete newline-terminated command in the buffer.
        while b"\n" in buf:
            line, _, buf = buf.partition(b"\n")
            cmd = line.decode('utf-8', 'ignore').strip().upper()
            if cmd == "EXIT":
                log("EXIT received")
                return False
            if cmd != "READ":
                continue   # ignore blank/unknown lines

            try:
                payload = read_once(scope)
                conn.sendall((json.dumps(payload) + "\n").encode('utf-8'))
                fail_state[0] = 0
                read_counter[0] += 1
                # Light periodic log so the server console shows progress
                # without spamming — every 50th successful read.
                if read_counter[0] <= 3 or read_counter[0] % 50 == 0:
                    log(f"served READ #{read_counter[0]} → mag={payload['magnification']}x")
            except Exception as e:
                fail_state[0] += 1
                log(f"READ error #{fail_state[0]}: {e}")
                try:
                    conn.sendall((json.dumps({"supported": False, "error": str(e)}) + "\n").encode('utf-8'))
                except OSError:
                    pass
                if fail_state[0] >= MAX_POLL_FAILS:
                    log("too many consecutive failures, re-init required")
                    return True


def main():
    services_dir = os.path.dirname(os.path.abspath(__file__))
    log(f"services_dir = {services_dir}")

    if hasattr(os, 'add_dll_directory'):
        try:
            os.add_dll_directory(services_dir)
        except Exception as e:
            log(f"add_dll_directory failed: {e}")

    try:
        hr = ctypes.windll.ole32.CoInitializeEx(None, 0x2)  # apartment-threaded
        log(f"CoInitializeEx hr=0x{hr & 0xFFFFFFFF:08X}")
    except Exception as e:
        log(f"CoInitializeEx failed (non-fatal): {e}")

    DNX64_cls, dll_path = load_api(services_dir)
    if DNX64_cls is None:
        return

    # Bind the TCP listener before initializing the scope so Node can start
    # its connect-retry loop in parallel with the ~2 s Init().
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server.bind(('127.0.0.1', PORT))
    except OSError as e:
        log(f"bind error on port {PORT}: {e}")
        emit({"supported": False, "error": f"Port {PORT} in use"})
        return
    server.listen(1)
    log(f"listening on 127.0.0.1:{PORT}")
    emit({"_amrPort": PORT})   # tells Node which port we bound

    while True:
        log("attempting Init()…")
        scope = init_scope(DNX64_cls, dll_path)
        if scope is None:
            time.sleep(RECONNECT_S)
            continue

        # Push an initial reading via stdout so the UI has a value to show
        # while Node is still establishing its TCP connection.
        try:
            emit(read_once(scope))
        except Exception as e:
            log(f"initial read failed: {e}")

        log("ready; accepting TCP connections")

        fail_state   = [0]
        read_counter = [0]
        reinit_needed = False
        while not reinit_needed:
            try:
                conn, addr = server.accept()
            except OSError as e:
                log(f"accept error: {e}")
                break
            log(f"client connected from {addr}")
            try:
                reinit_needed = serve_connection(conn, scope, fail_state, read_counter)
            finally:
                try: conn.close()
                except Exception: pass
                log("client disconnected")


if __name__ == "__main__":
    try:
        main()
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        # DNX64 leaves background threads running — force immediate exit.
        os._exit(0)
