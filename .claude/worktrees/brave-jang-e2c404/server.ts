import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { execSync, spawn } from "child_process";
import multer from "multer";
import cors from "cors";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: '200mb' }));
  app.use(express.urlencoded({ limit: '200mb', extended: true }));

  // Ensure temp directory exists
  const tempDir = path.join(process.cwd(), 'temp_scans');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  // ---------------------------------------------------------------------------
  // Resolve the correct Python 3 executable.
  // On Windows, "python3" doesn't exist and "python" may be the Microsoft Store
  // stub (reports version 0.0.0.0 and does nothing).  The Windows Python
  // Launcher "py" is the most reliable entry-point when Python was installed
  // via python.org, so we try candidates in this order:
  //   1. py      – Windows Python Launcher (python.org installer)
  //   2. python  – Conventional name; accepted only if it reports Python 3.x
  //   3. python3 – Standard on macOS/Linux; rarely present on Windows
  // ---------------------------------------------------------------------------
  const PYTHON_CANDIDATES = ['py', 'python', 'python3'];

  function resolvePython(): string | null {
    for (const candidate of PYTHON_CANDIDATES) {
      try {
        const out = execSync(`${candidate} --version`, { stdio: 'pipe' }).toString().trim();
        // Accept only if it reports a real Python 3.x version string
        if (/Python 3\.\d+/.test(out)) {
          console.log(`Python found: "${candidate}" → ${out}`);
          return candidate;
        }
      } catch {
        // candidate not found or errored – try the next one
      }
    }
    return null;
  }

  const pythonExec = resolvePython();

  if (!pythonExec) {
    console.warn("Warning: Python 3 was not found or failed to initialize. Depth estimation will be disabled.");
  } else {
    // Verify required libraries and install any that are missing
    console.log("Verifying Python libraries...");
    try {
      execSync(`${pythonExec} -c "import numpy, cv2, pywt, scipy, matplotlib, PIL"`, { stdio: 'pipe' });
      console.log("Python libraries verified.");
    } catch {
      console.log("Some Python libraries missing. Attempting installation...");
      try {
        execSync(`${pythonExec} -m pip install numpy opencv-python PyWavelets scipy matplotlib Pillow`, { stdio: 'inherit' });
        console.log("Python libraries installed successfully.");
      } catch (installErr) {
        console.warn("Warning: Could not install Python libraries. Depth estimation may fail.", installErr);
      }
    }
  }

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // --------------------------------------------------------------------------
  // Microscope AMR – per-request Python spawn.
  //
  // We tried keeping a long-running daemon, but the DNX64 DLL caches GetAMR
  // results inside a single Init() session — every read after the first one
  // returns the same value until Init() is called again.  So we're back to
  // the original model: each request spawns get_amr.py fresh, which pays a
  // one-time ~2 s Init() cost in exchange for an actual live reading.
  //
  // The client polls this endpoint on a timer with its own in-flight guard,
  // so the UI still updates automatically — just at roughly 2 s cadence.
  // --------------------------------------------------------------------------
  app.get("/api/microscope/amr", (req, res) => {
    if (!pythonExec) {
      return res.status(500).json({ supported: false, error: "Python not available" });
    }
    const scriptPath = path.join(process.cwd(), "services", "get_amr.py");
    const proc = spawn(pythonExec, [scriptPath]);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      // Surface Python diagnostic lines in the server console.
      process.stderr.write(chunk);
    });

    const timer = setTimeout(() => {
      console.warn("[AMR] script timed out after 15 s, killing");
      proc.kill();
      if (!res.headersSent) {
        res.status(504).json({ supported: false, error: "Microscope query timed out" });
      }
    }, 15000);

    proc.on("close", () => {
      clearTimeout(timer);
      if (res.headersSent) return;
      // DNX64 prints its own stdout junk ("U3Open: USB\…") alongside our
      // JSON payload, so extract the last line that looks like a JSON
      // object rather than parsing the whole buffer.
      const jsonLine = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{") && l.endsWith("}"))
        .pop();
      if (jsonLine) {
        try {
          res.json(JSON.parse(jsonLine));
          return;
        } catch { /* fall through */ }
      }
      res.status(500).json({
        supported: false,
        error: stderr.trim().split("\n").pop() || "Invalid response from microscope script",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Camera controls — read state
  // -------------------------------------------------------------------------
  app.get("/api/microscope/camera", (req, res) => {
    if (!pythonExec) {
      return res.status(500).json({ ok: false, error: "Python not available" });
    }
    const scriptPath = path.join(process.cwd(), "services", "get_camera_state.py");
    const proc = spawn(pythonExec, [scriptPath]);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      process.stderr.write(chunk);
    });

    const timer = setTimeout(() => {
      console.warn("[CAMERA] get_camera_state.py timed out after 15s");
      proc.kill();
      if (!res.headersSent) {
        res.status(504).json({ ok: false, error: "Camera state query timed out" });
      }
    }, 15000);

    proc.on("close", () => {
      clearTimeout(timer);
      if (res.headersSent) return;
      const jsonLine = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{") && l.endsWith("}"))
        .pop();
      if (jsonLine) {
        try { res.json(JSON.parse(jsonLine)); return; } catch { /* fall through */ }
      }
      res.status(500).json({
        ok: false,
        error: stderr.trim().split("\n").pop() || "Invalid response from get_camera_state.py",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Camera controls — apply settings
  // -------------------------------------------------------------------------
  app.post("/api/microscope/camera", (req, res) => {
    if (!pythonExec) {
      return res.status(500).json({ ok: false, error: "Python not available" });
    }
    const { autoExposure, exposure, gain } = req.body as {
      autoExposure: boolean;
      exposure: number;
      gain: number;
    };
    if (typeof autoExposure !== "boolean" || typeof exposure !== "number" || typeof gain !== "number") {
      return res.status(400).json({ ok: false, error: "Invalid parameters: expected { autoExposure: boolean, exposure: number, gain: number }" });
    }

    const scriptPath = path.join(process.cwd(), "services", "set_camera.py");
    const proc = spawn(pythonExec, [
      scriptPath,
      "--ae", autoExposure ? "1" : "0",
      "--exposure", String(Math.round(exposure)),
      "--gain", String(Math.round(gain)),
    ]);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      process.stderr.write(chunk);
    });

    const timer = setTimeout(() => {
      console.warn("[CAMERA] set_camera.py timed out after 15s");
      proc.kill();
      if (!res.headersSent) {
        res.status(504).json({ ok: false, error: "Camera set timed out" });
      }
    }, 15000);

    proc.on("close", () => {
      clearTimeout(timer);
      if (res.headersSent) return;
      const jsonLine = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{") && l.endsWith("}"))
        .pop();
      if (jsonLine) {
        try { res.json(JSON.parse(jsonLine)); return; } catch { /* fall through */ }
      }
      res.status(500).json({
        ok: false,
        error: stderr.trim().split("\n").pop() || "Invalid response from set_camera.py",
      });
    });
  });

  // Depth Estimation API
  app.post("/api/depth/compute", async (req, res) => {
    const { images, settings } = req.body;
    
    if (!images || !Array.isArray(images) || images.length < 3) {
      return res.status(400).json({ error: "At least 3 images are required for depth estimation." });
    }

    const scanId = `scan_${Date.now()}`;
    const scanPath = path.join(tempDir, scanId);
    fs.mkdirSync(scanPath);

    try {
      console.log(`DEPTH_API: Received request. Method: ${settings.method}, PixelRes: ${settings.pixelResolutionUm}, Downscale: ${settings.downscale}`);
      // Save images to temp folder
      const imagePaths: string[] = [];
      images.forEach((img: any, idx: number) => {
        const base64Data = img.dataUrl.split(',')[1];
        const filePath = path.join(scanPath, `img_${idx.toString().padStart(3, '0')}.jpg`);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        imagePaths.push(filePath);
      });

      // Prepare config for Python script
      const config = {
        image_folder: scanPath,
        z_step_mm: (settings.zStepMicrons || 100) / 1000,
        method: settings.method || 'laplacian',
        downscale: settings.downscale || 1.0,
        pixel_resolution_um: (settings.pixelResolutionUm && settings.pixelResolutionUm > 0 ? settings.pixelResolutionUm : 1.0) * (settings.downscale || 1.0) * (settings.xyCalibration || 1.0),
        preprocess: 'clahe',
        first_hit_fraction: 0.8,
        support_radius_px: 2,
        support_fraction: 0.5,
        min_global_fraction: 0.1,
        high_is_earliest: false // First image is lowest Z in our G-code
      };

      console.log(`[DEPTH] Starting depth computation for ${images.length} images using ${config.method}. Pixel Res: ${config.pixel_resolution_um.toFixed(3)} um/px`);

      const configPath = path.join(scanPath, 'config.json');
      fs.writeFileSync(configPath, JSON.stringify(config));

      // Run Python script
      const pythonScriptPath = path.join(process.cwd(), 'services', 'depth_processor.py');

      if (!pythonExec) {
        return res.status(500).json({ error: "Python 3 is not available on this system. Depth estimation is disabled." });
      }

      const pythonProcess = spawn(pythonExec, [pythonScriptPath, configPath]);

      let stdout = '';
      let stderr = '';

      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          console.error(`Python script failed with code ${code}: ${stderr}`);
          return res.status(500).json({ error: "Depth estimation failed on server.", details: stderr });
        }

        try {
          // Find the JSON output in stdout using markers
          const startMarker = "---JSON_START---";
          const endMarker = "---JSON_END---";
          const startIndex = stdout.indexOf(startMarker);
          const endIndex = stdout.indexOf(endMarker);

          if (startIndex === -1 || endIndex === -1) {
            // Fallback to old regex if markers not found (shouldn't happen with new script)
            const jsonMatch = stdout.match(/\{.*\}/s);
            if (!jsonMatch) {
              throw new Error("No JSON output found from Python script.");
            }
            const result = JSON.parse(jsonMatch[0]);
            handleResult(result);
          } else {
            const jsonStr = stdout.substring(startIndex + startMarker.length, endIndex).trim();
            const result = JSON.parse(jsonStr);
            handleResult(result);
          }
          
          function handleResult(result: any) {
            if (result.error) {
              return res.status(500).json({ error: result.error });
            }

            // Read the heatmap image
            const heatmapPath = path.join(scanPath, 'heatmap.jpg');
            if (fs.existsSync(heatmapPath)) {
              const heatmapBase64 = fs.readFileSync(heatmapPath).toString('base64');
              result.dataUrl = `data:image/jpeg;base64,${heatmapBase64}`;
            } else {
              console.warn(`[DEPTH] Heatmap image not found at ${heatmapPath}`);
            }

            console.log(`[DEPTH] Computation complete for ${config.method}. MinZ: ${result.minZ?.toFixed(3)}, MaxZ: ${result.maxZ?.toFixed(3)}`);
            res.json(result);
          }
        } catch (parseErr) {
          console.error("Failed to parse Python output:", parseErr, stdout);
          res.status(500).json({ error: "Failed to parse depth estimation results." });
        } finally {
          // Cleanup temp files
          // fs.rmSync(scanPath, { recursive: true, force: true });
        }
      });

    } catch (err) {
      console.error("Depth computation error:", err);
      res.status(500).json({ error: "Internal server error during depth computation." });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`ERROR: Port ${PORT} is already in use. Please close the other process or use a different port.`);
      process.exit(1);
    } else {
      console.error("Server error:", err);
      process.exit(1);
    }
  });
}

// Global error handlers to prevent silent crashes and loops
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
  process.exit(1);
});

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
