
import React from 'react';
import { ScanSettings, GridDimensions } from '../types';
import { INCH_TO_MM } from '../constants';

interface Props {
  settings: ScanSettings;
  grid: GridDimensions;
}

const Visualizer: React.FC<Props> = ({ settings, grid }) => {
  const widthMm = settings.sampleWidth * INCH_TO_MM;
  const heightMm = settings.sampleHeight * INCH_TO_MM;
  
  // Scaling for preview
  const padding = 20;
  const maxView = 300;
  const scale = Math.min(maxView / widthMm, maxView / heightMm);
  
  const viewWidth = widthMm * scale + padding * 2;
  const viewHeight = heightMm * scale + padding * 2;

  const rects = [];
  const pathPoints = [];

  // Row r=0 is the first row captured and always appears at the top visually
  for (let r = 0; r < grid.rows; r++) {
    const isEvenRow = r % 2 === 0;
    const startCol = isEvenRow ? 0 : grid.cols - 1;
    const endCol = isEvenRow ? grid.cols : -1;
    const step = isEvenRow ? 1 : -1;

    for (let c = startCol; c !== endCol; c += step) {
      const x = c * grid.stepX * scale + padding;
      // Screen Y always increases with the capture index r
      const y = r * grid.stepY * scale + padding;
      const w = grid.fovX * scale;
      const h = grid.fovY * scale;

      rects.push(
        <rect
          key={`rect-${r}-${c}`}
          x={x}
          y={y}
          width={w}
          height={h}
          className="fill-cyan-500/10 stroke-cyan-500/30"
          strokeWidth="1"
        />
      );

      pathPoints.push(`${x + w/2},${y + h/2}`);
    }
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 flex flex-col items-center justify-center">
      <div className="mb-4 text-center">
        <h3 className="text-lg font-semibold text-slate-200">Scanning Path Visualization</h3>
        <p className="text-xs text-slate-500 mt-1 uppercase font-bold tracking-widest">
          Standard Top-to-Bottom Serpentine Pattern
        </p>
      </div>
      
      <svg 
        width={viewWidth} 
        height={viewHeight} 
        viewBox={`0 0 ${viewWidth} ${viewHeight}`}
        className="rounded border border-slate-700 bg-black/40 shadow-inner"
      >
        {/* Sample Area */}
        <rect 
          x={padding} 
          y={padding} 
          width={widthMm * scale} 
          height={heightMm * scale} 
          fill="none" 
          stroke="#334155" 
          strokeDasharray="4 4" 
        />
        
        {/* Tiles */}
        {rects}
        
        {/* Path Line */}
        <polyline
          points={pathPoints.join(' ')}
          fill="none"
          stroke="#f59e0b"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.6"
        />
      </svg>
      
      <div className="mt-6 grid grid-cols-2 gap-4 w-full text-xs">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-cyan-500/20 border border-cyan-500/50"></div>
          <span className="text-slate-400">Microscope FOV ({grid.fovX.toFixed(1)} x {grid.fovY.toFixed(1)}mm)</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-1 bg-amber-500 opacity-60"></div>
          <span className="text-slate-400">Movement Path</span>
        </div>
      </div>
    </div>
  );
};

export default Visualizer;
