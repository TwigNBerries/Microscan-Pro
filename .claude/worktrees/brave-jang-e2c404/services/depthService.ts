
/**
 * Depth Estimation Service
 * 
 * Computes a topographic heatmap based on focus stacking.
 * Uses Gaussian fitting of focus measures across the Z-stack.
 */

import { CapturedImage, DepthMethod } from '../types';

// Viridis colormap lookup (simplified)
const VIRIDIS_MAP: [number, number, number][] = [
  [68, 1, 84], [72, 35, 116], [64, 67, 135], [52, 94, 141], 
  [41, 120, 142], [32, 144, 140], [34, 167, 132], [68, 190, 112], 
  [121, 209, 81], [189, 222, 38], [253, 231, 36]
];

function getViridisColor(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t));
  const n = VIRIDIS_MAP.length - 1;
  const i = Math.floor(t * n);
  const j = Math.ceil(t * n);
  const f = (t * n) - i;
  
  const c1 = VIRIDIS_MAP[i];
  const c2 = VIRIDIS_MAP[j];
  
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * f),
    Math.round(c1[1] + (c2[1] - c1[1]) * f),
    Math.round(c1[2] + (c2[2] - c1[2]) * f)
  ];
}

/**
 * Focus Measure: Sum of Wavelet Coefficients (WAV1)
 * Uses a simple Haar Discrete Wavelet Transform
 */
function fm_wav1(data: Uint8ClampedArray, width: number, height: number): Float32Array {
  const fm = new Float32Array(width * height);
  const lum = new Float32Array(width * height);
  
  // Precompute luminance
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    lum[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  // Apply Haar DWT (1st level)
  // We process 2x2 blocks
  for (let y = 0; y < height - 1; y += 2) {
    for (let x = 0; x < width - 1; x += 2) {
      const p00 = lum[y * width + x];
      const p01 = lum[y * width + (x + 1)];
      const p10 = lum[(y + 1) * width + x];
      const p11 = lum[(y + 1) * width + (x + 1)];

      // Haar coefficients
      // LL = (p00 + p01 + p10 + p11) / 4
      // HL = (p00 - p01 + p10 - p11) / 4 (Horizontal details)
      // LH = (p00 + p01 - p10 - p11) / 4 (Vertical details)
      // HH = (p00 - p01 - p10 + p11) / 4 (Diagonal details)
      
      const hl = Math.abs(p00 - p01 + p10 - p11) / 4;
      const lh = Math.abs(p00 + p01 - p10 - p11) / 4;
      const hh = Math.abs(p00 - p01 - p10 + p11) / 4;
      
      const energy = hl + lh + hh;
      
      // Assign energy to all 4 pixels in the 2x2 block
      fm[y * width + x] = energy;
      fm[y * width + (x + 1)] = energy;
      fm[(y + 1) * width + x] = energy;
      fm[(y + 1) * width + (x + 1)] = energy;
    }
  }
  
  return fm;
}

/**
 * Focus Measure: Tenengrad
 * Uses Sobel operator to compute gradient magnitude
 */
function fm_tenengrad(data: Uint8ClampedArray, width: number, height: number): Float32Array {
  const fm = new Float32Array(width * height);
  const getLum = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  };

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      // Sobel kernels
      const gx = (getLum(x + 1, y - 1) + 2 * getLum(x + 1, y) + getLum(x + 1, y + 1)) -
                 (getLum(x - 1, y - 1) + 2 * getLum(x - 1, y) + getLum(x - 1, y + 1));
      const gy = (getLum(x - 1, y + 1) + 2 * getLum(x, y + 1) + getLum(x + 1, y + 1)) -
                 (getLum(x - 1, y - 1) + 2 * getLum(x, y - 1) + getLum(x + 1, y - 1));
      
      fm[y * width + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return fm;
}

/**
 * Focus Measure: Modified Laplacian
 */
function fm_laplacian(data: Uint8ClampedArray, width: number, height: number): Float32Array {
  const fm = new Float32Array(width * height);
  const getLum = (x: number, y: number) => {
    const idx = (y * width + x) * 4;
    return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  };

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const mlX = Math.abs(2 * getLum(x, y) - getLum(x - 1, y) - getLum(x + 1, y));
      const mlY = Math.abs(2 * getLum(x, y) - getLum(x, y - 1) - getLum(x, y + 1));
      fm[y * width + x] = mlX + mlY;
    }
  }
  return fm;
}

export interface DepthMapResult {
  dataUrl: string;
  depthValues: number[];
  width: number;
  height: number;
  minZ: number;
  maxZ: number;
}

export const computeDepthMap = async (
  images: CapturedImage[], 
  method: DepthMethod = 'laplacian',
  downscaleFactor: number = 1.0,
  zStepMicrons: number = 100,
  pixelResolutionUm: number = 1.0
): Promise<DepthMapResult> => {
  if (images.length < 3) throw new Error("Need at least 3 images for Gaussian fit");

  // Sort images by Z position
  const sortedImages = [...images].sort((a, b) => a.gridPos.z - b.gridPos.z);
  
  // Call server-side depth estimation
  const response = await fetch('/api/depth/compute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      images: sortedImages,
      settings: {
        method,
        zStepMicrons,
        downscale: downscaleFactor,
        pixelResolutionUm,
        xyCalibration: 1.0
      }
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || "Failed to compute depth map on server.");
  }

  const result = await response.json();
  
  // Convert mm to microns (backend returns mm based on zStepMicrons/1000)
  const depthValuesMicrons = result.depthValues.map((v: number) => v * 1000);

  return {
    dataUrl: result.dataUrl,
    depthValues: depthValuesMicrons,
    width: result.width,
    height: result.height,
    minZ: result.minZ,
    maxZ: result.maxZ,
  };
};
