# Auto Depth Estimation Queue — Design Spec

**Date:** 2026-04-19  
**Status:** Approved

## Problem

Depth estimation currently requires the user to wait for the entire scan to finish, manually navigate to the Depth tab, and click "Analyze All". The Python process is idle during scanning and could be processing completed tiles in the background.

## Goal

Start depth estimation automatically as soon as each tile's Z-stack is fully captured, while the scan continues. Processing must be sequential to avoid multi-process CPU/memory pressure on low-end machines.

## Scope

Changes are confined to `App.tsx`. No changes to `server.ts`, `services/depth_processor.py`, `services/depthService.ts`, `components/DepthLab.tsx`, or any other file.

## Design

### New refs (App.tsx)

Two refs added alongside existing refs (`amrInFlightRef`, etc.):

```ts
const depthQueueRef = useRef<{ label: string; images: CapturedImage[] }[]>([]);
const isDepthProcessingRef = useRef(false);
```

- `depthQueueRef` — ordered list of tiles waiting for depth processing. Uses a ref (not state) to avoid re-renders on enqueue/dequeue.
- `isDepthProcessingRef` — mutex flag; true while a Python process is running for a tile.

### `drainDepthQueue` function

```ts
const drainDepthQueue = useCallback(async () => {
  if (isDepthProcessingRef.current || depthQueueRef.current.length === 0) return;
  isDepthProcessingRef.current = true;
  const item = depthQueueRef.current.shift()!;
  try {
    await handleTriggerDepth(item.label, item.images, 'tenengrad');
  } finally {
    isDepthProcessingRef.current = false;
    drainDepthQueue();
  }
}, [handleTriggerDepth]);
```

`try/finally` guarantees the mutex is always cleared and the next item is always attempted, even if `handleTriggerDepth` throws unexpectedly.

Behavior:
1. Guard: exits immediately if a process is already running or the queue is empty.
2. Sets the mutex, pops the oldest item, awaits the full depth pipeline (HTTP POST → Python → result stored in `depthResults`).
3. Clears the mutex, recurses to pick up the next queued tile.

Dependencies: only `handleTriggerDepth`, which is already a `useCallback`.

### Extend existing useEffect (App.tsx:222)

Inside the `images.length === zStackCount` branch, after the existing `handleTriggerStack` call:

```ts
if (!depthResults[label] && !depthQueueRef.current.find(i => i.label === label)) {
  depthQueueRef.current.push({ label, images });
  drainDepthQueue();
}
```

Guard conditions:
- `!depthResults[label]` — skip tiles that already have a completed result (e.g. from a previous run or manual trigger).
- `!depthQueueRef.current.find(...)` — skip tiles already in the pending queue (prevents double-enqueue if the useEffect fires more than once for the same tile).

The useEffect dependency array must include `depthResults` and `drainDepthQueue` in addition to the existing `[groupedCapturedImages, settings.zStackCount, stackedResults]`.

### Default method

`tenengrad` is used for all auto-queued tiles. The DepthLab method selector continues to apply for manual re-processing via "Analyze All".

## What does NOT change

- `handleTriggerDepth` — unchanged; called the same way as the manual path.
- `POST /api/depth/compute` endpoint — unchanged.
- `depth_processor.py` — unchanged.
- `DepthLab.tsx` "Analyze All" button — still works; re-processes tiles with the user-selected method.
- The DepthLab UI display of results — unchanged; `depthResults` state is populated the same way.

## Error handling

`handleTriggerDepth` already catches errors and clears the result for that tile. If it throws, `drainDepthQueue` will still clear `isDepthProcessingRef` and recurse, so a failed tile does not stall the queue.

## Sequential guarantee

The `isDepthProcessingRef` mutex ensures only one Python child process runs at a time. Tiles are processed in FIFO order matching the scan's capture order.
