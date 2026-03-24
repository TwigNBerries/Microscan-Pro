
export type GCodeFlavor = 'marlin' | 'grbl';

export interface ScanSettings {
  sampleWidth: number; // in inches or cm
  sampleHeight: number; // in inches or cm
  units: 'in' | 'cm';
  magnification: number; // multiplier
  overlapPercent: number; // 0-100
  zStackCount: number;
  zStepMicrons: number;
  stabilizeXYMs: number; // Delay after XY move before stack starts
  settleZMs: number; // Delay after each Z step
  gcodeFlavor: GCodeFlavor;
  depthDownscale: boolean; // Whether to downscale to 1080p for depth estimation
}

export interface GridDimensions {
  fovX: number; // mm
  fovY: number; // mm
  stepX: number; // mm
  stepY: number; // mm
  cols: number;
  rows: number;
  totalImages: number;
}

export interface CapturedImage {
  id: string;
  name: string;
  label: string; // The alphabetical stack label (A, B, AA, etc)
  dataUrl: string;
  timestamp: number;
  gridPos: { r: number; c: number; z: number };
}

export interface StackResult {
  label: string;
  dataUrl: string;
  isProcessing: boolean;
  sliceCount: number;
}

export type DepthMethod = 'laplacian' | 'tenengrad' | 'wav1';

export interface DepthResult {
  label: string;
  dataUrl: string; // The heatmap image
  depthValues: number[]; // Flat array of depth values (mu)
  width: number;
  height: number;
  isProcessing: boolean;
  minZ: number;
  maxZ: number;
  method: DepthMethod;
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface SerialState {
  connected: boolean;
  port: any | null;
  writer: any | null;
}
