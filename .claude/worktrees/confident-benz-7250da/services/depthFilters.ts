/**
 * Depth-map filters (sentinel-aware).
 *
 * Every filter skips the `-1` uncovered-cell sentinel and `NaN` when building
 * a neighborhood sample, and passes them through unchanged if they happen to
 * be the center pixel. This matches the serializer in `depthStitcher.ts`
 * where -1 represents cells no tile covered.
 */

export type HampelConfig    = { enabled: boolean; kernel: 3 | 5 | 7; threshold: number };
export type MedianConfig    = { enabled: boolean; kernel: 3 | 5 | 7 | 9 };
export type BilateralConfig = { enabled: boolean; spatialSigma: number; rangeSigma: number };

export type FilterConfig = {
  hampel:    HampelConfig;
  median:    MedianConfig;
  bilateral: BilateralConfig;
};

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  hampel:    { enabled: true, kernel: 5, threshold: 3.0 },
  median:    { enabled: true, kernel: 3 },
  bilateral: { enabled: true, spatialSigma: 1.5, rangeSigma: 20 },
};

function isValid(z: number): boolean {
  return Number.isFinite(z) && z >= 0;
}

export function medianFilter(
  src: Float32Array, w: number, h: number, kernel: number,
): Float32Array {
  const out = new Float32Array(src.length);
  const r = (kernel - 1) >> 1;
  const bufCap = kernel * kernel;
  const buf = new Float64Array(bufCap);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const center = src[y * w + x];
      if (!isValid(center)) { out[y * w + x] = center; continue; }
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        let sy = y + dy;
        if (sy < 0) sy = -sy;
        else if (sy >= h) sy = 2 * h - 2 - sy;
        for (let dx = -r; dx <= r; dx++) {
          let sx = x + dx;
          if (sx < 0) sx = -sx;
          else if (sx >= w) sx = 2 * w - 2 - sx;
          const s = src[sy * w + sx];
          if (isValid(s)) buf[n++] = s;
        }
      }
      if (n === 0) { out[y * w + x] = center; continue; }
      // Partial sort up to n
      for (let i = 1; i < n; i++) {
        const v = buf[i]; let j = i - 1;
        while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
        buf[j + 1] = v;
      }
      out[y * w + x] = (n & 1) ? buf[n >> 1] : 0.5 * (buf[(n >> 1) - 1] + buf[n >> 1]);
    }
  }
  return out;
}

export function hampelFilter(
  src: Float32Array, w: number, h: number, kernel: number, threshold: number,
): Float32Array {
  const out = new Float32Array(src.length);
  const r = (kernel - 1) >> 1;
  const bufCap = kernel * kernel;
  const buf = new Float64Array(bufCap);
  const devBuf = new Float64Array(bufCap);
  const K = 1.4826;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const center = src[y * w + x];
      if (!isValid(center)) { out[y * w + x] = center; continue; }
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        let sy = y + dy;
        if (sy < 0) sy = -sy;
        else if (sy >= h) sy = 2 * h - 2 - sy;
        for (let dx = -r; dx <= r; dx++) {
          let sx = x + dx;
          if (sx < 0) sx = -sx;
          else if (sx >= w) sx = 2 * w - 2 - sx;
          const s = src[sy * w + sx];
          if (isValid(s)) buf[n++] = s;
        }
      }
      if (n < 3) { out[y * w + x] = center; continue; }
      for (let i = 1; i < n; i++) {
        const v = buf[i]; let j = i - 1;
        while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
        buf[j + 1] = v;
      }
      const med = (n & 1) ? buf[n >> 1] : 0.5 * (buf[(n >> 1) - 1] + buf[n >> 1]);
      for (let i = 0; i < n; i++) devBuf[i] = Math.abs(buf[i] - med);
      for (let i = 1; i < n; i++) {
        const v = devBuf[i]; let j = i - 1;
        while (j >= 0 && devBuf[j] > v) { devBuf[j + 1] = devBuf[j]; j--; }
        devBuf[j + 1] = v;
      }
      const mad = (n & 1) ? devBuf[n >> 1] : 0.5 * (devBuf[(n >> 1) - 1] + devBuf[n >> 1]);
      const sigma = K * mad;
      out[y * w + x] = Math.abs(center - med) > threshold * sigma ? med : center;
    }
  }
  return out;
}

export function bilateralFilter(
  src: Float32Array, w: number, h: number, spatialSigma: number, rangeSigma: number,
): Float32Array {
  const out = new Float32Array(src.length);
  const r = Math.min(7, Math.max(1, Math.round(3 * spatialSigma)));
  const twoSs2 = 2 * spatialSigma * spatialSigma;
  const twoSr2 = 2 * rangeSigma * rangeSigma;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const center = src[y * w + x];
      if (!isValid(center)) { out[y * w + x] = center; continue; }
      let wsum = 0;
      let vsum = 0;
      for (let dy = -r; dy <= r; dy++) {
        let sy = y + dy;
        if (sy < 0) sy = -sy;
        else if (sy >= h) sy = 2 * h - 2 - sy;
        for (let dx = -r; dx <= r; dx++) {
          let sx = x + dx;
          if (sx < 0) sx = -sx;
          else if (sx >= w) sx = 2 * w - 2 - sx;
          const s = src[sy * w + sx];
          if (!isValid(s)) continue;
          const ws = Math.exp(-(dx * dx + dy * dy) / twoSs2);
          const dz = s - center;
          const wr = Math.exp(-(dz * dz) / twoSr2);
          const wt = ws * wr;
          wsum += wt;
          vsum += s * wt;
        }
      }
      out[y * w + x] = wsum > 0 ? vsum / wsum : center;
    }
  }
  return out;
}

export function applyPipeline(
  src: Float32Array, w: number, h: number, config: FilterConfig,
): Float32Array {
  let out = src;
  if (config.hampel.enabled) {
    out = hampelFilter(out, w, h, config.hampel.kernel, config.hampel.threshold);
  }
  if (config.median.enabled) {
    out = medianFilter(out, w, h, config.median.kernel);
  }
  if (config.bilateral.enabled) {
    out = bilateralFilter(out, w, h, config.bilateral.spatialSigma, config.bilateral.rangeSigma);
  }
  return out;
}
