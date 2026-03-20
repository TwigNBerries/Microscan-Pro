
import { ScanSettings, GridDimensions } from '../types';
import { 
  MICROSCOPE_DATA, 
  INCH_TO_MM, 
  GCODE_HEADER, 
  GCODE_FOOTER,
  MicroscopeDataPoint
} from '../constants';

export const getInterpolatedData = (m: number): MicroscopeDataPoint => {
  if (m <= MICROSCOPE_DATA[0].m) return MICROSCOPE_DATA[0];
  if (m >= MICROSCOPE_DATA[MICROSCOPE_DATA.length - 1].m) return MICROSCOPE_DATA[MICROSCOPE_DATA.length - 1];

  let p1 = MICROSCOPE_DATA[0];
  let p2 = MICROSCOPE_DATA[1];

  for (let i = 0; i < MICROSCOPE_DATA.length - 1; i++) {
    if (m >= MICROSCOPE_DATA[i].m && m <= MICROSCOPE_DATA[i + 1].m) {
      p1 = MICROSCOPE_DATA[i];
      p2 = MICROSCOPE_DATA[i + 1];
      break;
    }
  }

  const factor = (m - p1.m) / (p2.m - p1.m);

  return {
    m,
    wd: p1.wd + (p2.wd - p1.wd) * factor,
    fovX: p1.fovX + (p2.fovX - p1.fovX) * factor,
    fovY: p1.fovY + (p2.fovY - p1.fovY) * factor,
    dof: p1.dof + (p2.dof - p1.dof) * factor
  };
};

export const getAlphabetLabel = (index: number): string => {
  let label = "";
  let i = index;
  while (i >= 0) {
    label = String.fromCharCode((i % 26) + 65) + label;
    i = Math.floor(i / 26) - 1;
  }
  return label;
};

export const calculateGrid = (settings: ScanSettings): GridDimensions => {
  const { sampleWidth, sampleHeight, magnification, overlapPercent } = settings;
  const data = getInterpolatedData(magnification);
  const fovX = data.fovX;
  const fovY = data.fovY;
  
  const overlapFactor = 1 - (overlapPercent / 100);
  const stepX = fovX * overlapFactor;
  const stepY = fovY * overlapFactor;
  
  const widthMm = sampleWidth * INCH_TO_MM;
  const heightMm = sampleHeight * INCH_TO_MM;
  
  const cols = Math.ceil(widthMm / stepX);
  const rows = Math.ceil(heightMm / stepY);
  
  return {
    fovX,
    fovY,
    stepX,
    stepY,
    cols,
    rows,
    totalImages: cols * rows * settings.zStackCount
  };
};

export const generateGCode = (settings: ScanSettings, grid: GridDimensions): string => {
  const lines: string[] = [...GCODE_HEADER];
  const { zStackCount, zStepMicrons, stabilizeXYMs, settleZMs, gcodeFlavor } = settings;
  const zStepMm = zStepMicrons / 1000;

  const getDelayCmd = (ms: number) => {
    if (ms <= 0) return "";
    if (gcodeFlavor === 'grbl') {
      return `G4 P${(ms / 1000).toFixed(3)}`;
    }
    // For Marlin, use S (seconds) to avoid P (ms) vs S (s) confusion in some firmwares
    return `G4 S${(ms / 1000).toFixed(3)}`;
  };

  for (let r = 0; r < grid.rows; r++) {
    const isEvenRow = r % 2 === 0;
    const startCol = isEvenRow ? 0 : grid.cols - 1;
    const endCol = isEvenRow ? grid.cols : -1;
    const step = isEvenRow ? 1 : -1;

    const rowLabel = getAlphabetLabel(r);
    const yPos = -r * grid.stepY;

    for (let c = startCol; c !== endCol; c += step) {
      const xPos = c * grid.stepX;
      const colLabel = c + 1;
      const stackLabel = `${rowLabel}${colLabel}`;

      lines.push(`; --- Position ${stackLabel} ---`);
      // Move to XY and then Z-start (10.0) sequentially before stabilizing
      lines.push(`G1 X${xPos.toFixed(3)} Y${yPos.toFixed(3)} F3000`);
      lines.push(`G1 Z10.000 F800`);
      
      const stabilizeCmd = getDelayCmd(stabilizeXYMs);
      if (stabilizeCmd) lines.push(stabilizeCmd);
      
      for (let z = 0; z < zStackCount; z++) {
        const zPos = 10 + (z * zStepMm);
        
        // If z=0, we are already at Z10.0 from the move above
        if (z > 0) {
          lines.push(`G1 Z${zPos.toFixed(3)} F800`);
          const settleCmd = getDelayCmd(settleZMs);
          if (settleCmd) lines.push(settleCmd);
        }
        
        lines.push(`; APP_CAPTURE ${stackLabel} ${r} ${c} ${z}`);
      }
    }
  }

  lines.push(...GCODE_FOOTER);
  return lines.join('\n');
};
