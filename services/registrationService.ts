
/**
 * Registration Service for MicroScan
 * Uses OpenCV.js for feature-based and phase-correlation registration.
 */

declare const cv: any;

export type Shift = {
  dx: number;
  dy: number;
  score?: number;
  method: 'phase' | 'orb' | 'fallback';
};

/**
 * Ensures OpenCV is ready
 */
async function ensureCv(): Promise<void> {
  if (typeof cv !== 'undefined' && cv.Mat) return;
  
  return new Promise((resolve) => {
    const check = () => {
      if (typeof cv !== 'undefined' && cv.Mat) {
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

/**
 * Utility to convert ImageData to cv.Mat
 */
function imageDataToMat(imageData: ImageData) {
  return cv.matFromImageData(imageData);
}

/**
 * Estimates translation shift between two horizontal neighbors.
 * baseline: right tile placed at x = left.width - overlapWidth
 * shift dx, dy applied to that baseline.
 */
export async function estimateShiftHorizontal(
  left: ImageData,
  right: ImageData,
  overlapPercent: number
): Promise<Shift> {
  await ensureCv();

  const overlapWidth = Math.round(right.width * (overlapPercent / 100));
  const margin = Math.round(overlapWidth * 0.15); // 15% margin
  const roiWidth = overlapWidth + margin * 2;

  // ROIs: right edge of left, left edge of right
  // We need to be careful with bounds
  const leftX = Math.max(0, left.width - roiWidth);
  const rightX = 0;
  
  const actualRoiWidth = Math.min(roiWidth, left.width - leftX, right.width);

  try {
    const matL = imageDataToMat(left);
    const matR = imageDataToMat(right);

    const rectL = new cv.Rect(leftX, 0, actualRoiWidth, left.height);
    const rectR = new cv.Rect(rightX, 0, actualRoiWidth, right.height);

    const roiL = matL.roi(rectL);
    const roiR = matR.roi(rectR);

    // Try Phase Correlation first (Downsampled for speed)
    const shift = await tryPhaseCorrelation(roiL, roiR);
    
    // Clean up
    roiL.delete(); roiR.delete(); matL.delete(); matR.delete();

    if (shift && shift.score && shift.score > 0.1) {
      // Phase correlation returns shift relative to ROIs
      // In nominal overlap, left ROI x=left.width - roiW, right ROI x=0
      // If phase Correlate says shift is (sx, sy)
      // It means right ROI should be at sx, sy relative to left ROI
      // Nominal x offset: left.width - overlapWidth
      // We return dx, dy relative to that nominal x offset
      return {
        dx: shift.dx,
        dy: shift.dy,
        score: shift.score,
        method: 'phase'
      };
    }

    // Fallback to ORB or just 0,0
    return { dx: 0, dy: 0, method: 'fallback' };
  } catch (e) {
    console.warn("Shift estimation failed:", e);
    return { dx: 0, dy: 0, method: 'fallback' };
  }
}

/**
 * Estimates translation shift between two vertical neighbors.
 */
export async function estimateShiftVertical(
  top: ImageData,
  bottom: ImageData,
  overlapPercent: number
): Promise<Shift> {
  await ensureCv();

  const overlapHeight = Math.round(bottom.height * (overlapPercent / 100));
  const margin = Math.round(overlapHeight * 0.15);
  const roiHeight = overlapHeight + margin * 2;

  const topY = Math.max(0, top.height - roiHeight);
  const bottomY = 0;
  
  const actualRoiHeight = Math.min(roiHeight, top.height - topY, bottom.height);

  try {
    const matT = imageDataToMat(top);
    const matB = imageDataToMat(bottom);

    const rectT = new cv.Rect(0, topY, top.width, actualRoiHeight);
    const rectB = new cv.Rect(0, bottomY, bottom.width, actualRoiHeight);

    const roiT = matT.roi(rectT);
    const roiB = matB.roi(rectB);

    const shift = await tryPhaseCorrelation(roiT, roiB);
    
    roiT.delete(); roiB.delete(); matT.delete(); matB.delete();

    if (shift && shift.score && shift.score > 0.1) {
      return {
        dx: shift.dx,
        dy: shift.dy,
        score: shift.score,
        method: 'phase'
      };
    }

    return { dx: 0, dy: 0, method: 'fallback' };
  } catch (e) {
    console.warn("Shift estimation failed:", e);
    return { dx: 0, dy: 0, method: 'fallback' };
  }
}

async function tryPhaseCorrelation(roiA: any, roiB: any): Promise<{dx: number, dy: number, score: number} | null> {
  // Phase correlation works on single channel float32
  let grayA = new cv.Mat();
  let grayB = new cv.Mat();
  cv.cvtColor(roiA, grayA, cv.COLOR_RGBA2GRAY);
  cv.cvtColor(roiB, grayB, cv.COLOR_RGBA2GRAY);

  let fA = new cv.Mat();
  let fB = new cv.Mat();
  grayA.convertTo(fA, cv.CV_32F);
  grayB.convertTo(fB, cv.CV_32F);

  // Hanning window
  let hann = cv.createHanningWindow(fA.size(), cv.CV_32F);
  
  try {
    // phaseCorrelate returns [Point, response]
    // Point has x, y
    const result = cv.phaseCorrelate(fA, fB, hann);
    const shift = result.shift; // This is a point
    const response = result.response;

    grayA.delete(); grayB.delete(); fA.delete(); fB.delete(); hann.delete();

    return { dx: shift.x, dy: shift.y, score: response };
  } catch (e) {
    grayA.delete(); grayB.delete(); fA.delete(); fB.delete(); hann.delete();
    return null;
  }
}
