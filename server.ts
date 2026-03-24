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

  // Check for Python and required libraries
  console.log("Checking Python environment...");
  try {
    // Use a safer check that doesn't inherit stdio by default to avoid terminal noise
    const pythonVersion = execSync("python3 --version", { stdio: 'pipe' }).toString().trim();
    console.log(`Python version: ${pythonVersion}`);
    
    // Check if libraries are present before attempting install
    console.log("Verifying Python libraries...");
    try {
      // Just check if they can be imported
      execSync("python3 -c \"import numpy, cv2, pywt, scipy, matplotlib\"", { stdio: 'pipe' });
      console.log("Python libraries verified.");
    } catch (libErr) {
      console.log("Some Python libraries missing. Attempting installation...");
      try {
        execSync("python3 -m pip install numpy opencv-python PyWavelets scipy matplotlib", { stdio: 'inherit' });
        console.log("Python libraries installed successfully.");
      } catch (installErr) {
        console.warn("Warning: Could not install Python libraries. Depth estimation may fail.", installErr);
      }
    }
  } catch (err) {
    console.warn("Warning: Python 3 was not found or failed to initialize. Depth estimation will be disabled.");
  }

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
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
      
      const pythonProcess = spawn('python3', [pythonScriptPath, configPath]);

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
          // Find the JSON output in stdout (it might have other print statements)
          const jsonMatch = stdout.match(/\{.*\}/s);
          if (!jsonMatch) {
            throw new Error("No JSON output found from Python script.");
          }
          
          const result = JSON.parse(jsonMatch[0]);
          
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
