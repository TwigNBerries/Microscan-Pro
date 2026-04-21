/**
 * Client-side heatmap renderer for DepthResult.depthValues.
 * Used by the Processing tab preview — mirrors the visual style of the
 * existing Python-generated heatmap JPEGs closely enough to compare.
 */

const JET_LUT = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r: number, g: number, b: number;
    if (t < 0.125) { r = 0; g = 0; b = 0.5 + 4 * t; }
    else if (t < 0.375) { r = 0; g = 4 * (t - 0.125); b = 1; }
    else if (t < 0.625) { r = 4 * (t - 0.375); g = 1; b = 1 - 4 * (t - 0.375); }
    else if (t < 0.875) { r = 1; g = 1 - 4 * (t - 0.625); b = 0; }
    else                { r = 1 - 4 * (t - 0.875); if (r < 0.5) r = 0.5; g = 0; b = 0; }
    lut[i * 3]     = Math.round(255 * Math.max(0, Math.min(1, r)));
    lut[i * 3 + 1] = Math.round(255 * Math.max(0, Math.min(1, g)));
    lut[i * 3 + 2] = Math.round(255 * Math.max(0, Math.min(1, b)));
  }
  return lut;
})();

export function downsample(
  src: Float32Array, w: number, h: number, maxDim: number,
): { data: Float32Array; w: number; h: number } {
  const step = Math.max(1, Math.ceil(Math.max(w, h) / maxDim));
  if (step === 1) return { data: src, w, h };
  const nw = Math.floor(w / step);
  const nh = Math.floor(h / step);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      out[y * nw + x] = src[(y * step) * w + (x * step)];
    }
  }
  return { data: out, w: nw, h: nh };
}

export function renderDepthToCanvas(
  depthValues: Float32Array, w: number, h: number,
  min: number, max: number,
  canvas: HTMLCanvasElement,
): void {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(w, h);
  const range = max - min;
  const invRange = range > 0 ? 1 / range : 0;
  for (let i = 0; i < w * h; i++) {
    const z = depthValues[i];
    const px = i * 4;
    if (!Number.isFinite(z) || z < 0) {
      img.data[px] = 0; img.data[px + 1] = 0; img.data[px + 2] = 0; img.data[px + 3] = 0;
      continue;
    }
    const t = Math.max(0, Math.min(1, (z - min) * invRange));
    const idx = Math.round(t * 255) * 3;
    img.data[px]     = JET_LUT[idx];
    img.data[px + 1] = JET_LUT[idx + 1];
    img.data[px + 2] = JET_LUT[idx + 2];
    img.data[px + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
