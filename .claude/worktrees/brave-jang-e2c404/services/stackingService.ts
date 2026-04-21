
/**
 * Focus Stacking Service
 * 
 * UPGRADED TO: Sum of Modified Laplacian (SML / LAP2)
 * Based on: "Analysis of focus measure operators in shape-from-focus" (Pertuz et al.)
 * 
 * Algorithm:
 * 1. Compute Modified Laplacian (ML) for each pixel: 
 *    ML = |2*I(x,y) - I(x-1,y) - I(x+1,y)| + |2*I(x,y) - I(x,y-1) - I(x,y+1)|
 * 2. Sum the ML values over a local window Ω (5x5).
 * 3. Select pixel from the slice that maximizes this local sum.
 */

export const performFocusStack = async (imageUrls: string[]): Promise<string> => {
  if (imageUrls.length === 0) return "";
  if (imageUrls.length === 1) return imageUrls[0];

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return imageUrls[0];

  const images: HTMLImageElement[] = await Promise.all(
    imageUrls.map((url, idx) => new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load image at index ${idx}`));
      img.src = url;
    }))
  );

  const width = images[0].width;
  const height = images[0].height;
  canvas.width = width;
  canvas.height = height;

  const resultData = ctx.createImageData(width, height);
  const focusMeasureMap = new Float32Array(width * height);
  focusMeasureMap.fill(-1);

  // Buffer for Modified Laplacian values of current slice
  const mlBuffer = new Float32Array(width * height);

  for (const img of images) {
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    // 1. Calculate Modified Laplacian for the entire slice
    // Yield every 200 rows to keep UI responsive
    for (let y = 1; y < height - 1; y++) {
      if (y % 200 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * 4;
        
        const getLum = (offset: number) => 
          0.299 * data[offset] + 0.587 * data[offset+1] + 0.114 * data[offset+2];

        const mlX = Math.abs(2 * getLum(idx) - getLum(idx - 4) - getLum(idx + 4));
        const mlY = Math.abs(2 * getLum(idx) - getLum(idx - width * 4) - getLum(idx + width * 4));
        
        mlBuffer[y * width + x] = mlX + mlY;
      }
    }

    // 2. Sum Modified Laplacian over a 5x5 Window (Ω) using a sliding window optimization
    const winSize = 2; // Radius for 5x5
    const winDim = 5;
    
    // Pre-calculate column sums to speed up the sliding window
    const colSums = new Float32Array(width * height);
    for (let x = 0; x < width; x++) {
      let currentColSum = 0;
      // Initial window for this column
      for (let i = 0; i < winDim; i++) {
        currentColSum += mlBuffer[i * width + x];
      }
      colSums[winSize * width + x] = currentColSum;
      
      for (let y = winSize + 1; y < height - winSize; y++) {
        currentColSum = currentColSum - mlBuffer[(y - winSize - 1) * width + x] + mlBuffer[(y + winSize) * width + x];
        colSums[y * width + x] = currentColSum;
      }
    }

    // Now use the column sums to get the 5x5 area sum
    for (let y = winSize; y < height - winSize; y++) {
      if (y % 200 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      
      let currentWinSum = 0;
      // Initial window for this row
      for (let i = 0; i < winDim; i++) {
        currentWinSum += colSums[y * width + i];
      }
      
      for (let x = winSize; x < width - winSize; x++) {
        if (x > winSize) {
          currentWinSum = currentWinSum - colSums[y * width + (x - winSize - 1)] + colSums[y * width + (x + winSize)];
        }

        const mapIdx = y * width + x;
        if (currentWinSum > focusMeasureMap[mapIdx]) {
          focusMeasureMap[mapIdx] = currentWinSum;
          const pixelIdx = mapIdx * 4;
          resultData.data[pixelIdx] = data[pixelIdx];
          resultData.data[pixelIdx + 1] = data[pixelIdx + 1];
          resultData.data[pixelIdx + 2] = data[pixelIdx + 2];
          resultData.data[pixelIdx + 3] = 255;
        }
      }
    }
  }

  ctx.putImageData(resultData, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.92);
};
