# Auto Depth Estimation Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically start depth estimation for each tile as soon as its Z-stack is fully captured, processing tiles sequentially in a background queue while the scan continues.

**Architecture:** Two refs (`depthQueueRef` and `isDepthProcessingRef`) act as a FIFO queue and mutex. A `drainDepthQueue` useCallback pops items and awaits `handleTriggerDepth` one at a time, then recurses. The existing useEffect that triggers focus stacking is extended to also enqueue tiles for depth estimation and kick off the drain.

**Tech Stack:** React 19, TypeScript, existing `handleTriggerDepth` / `POST /api/depth/compute` pipeline (no new endpoints or Python changes).

---

### Task 1: Add queue refs

**Files:**
- Modify: `App.tsx:152-154` (alongside existing refs)

- [ ] **Step 1: Add the two refs after the existing `totalQueueSizeRef` on line 154**

Open `App.tsx`. After line 154 (`const totalQueueSizeRef = useRef<number>(0);`), insert:

```ts
  const depthQueueRef = useRef<{ label: string; images: CapturedImage[] }[]>([]);
  const isDepthProcessingRef = useRef(false);
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors (these are plain refs, no logic yet).

- [ ] **Step 3: Commit**

```bash
git add App.tsx
git commit -m "feat: add depthQueueRef and isDepthProcessingRef for sequential auto-depth"
```

---

### Task 2: Add `drainDepthQueue` function

**Files:**
- Modify: `App.tsx` — add new `useCallback` after `handleTriggerDepth` (which ends around line 284)

- [ ] **Step 1: Read the end of `handleTriggerDepth` to find the insertion point**

In `App.tsx`, locate the closing `}, []);` of `handleTriggerDepth` (around line 284). Insert `drainDepthQueue` immediately after it:

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

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. If you see `drainDepthQueue` referenced before declaration, ensure it is placed *after* `handleTriggerDepth` in the file.

- [ ] **Step 3: Commit**

```bash
git add App.tsx
git commit -m "feat: add drainDepthQueue sequential processor"
```

---

### Task 3: Extend the auto-trigger useEffect to enqueue depth jobs

**Files:**
- Modify: `App.tsx:222-230` — the useEffect that watches `groupedCapturedImages`

- [ ] **Step 1: Read the current useEffect**

Current code (lines 222–230):

```ts
  useEffect(() => {
    (Object.entries(groupedCapturedImages) as [string, CapturedImage[]][]).forEach(([label, images]) => {
      if (images.length === settings.zStackCount) {
        if (!stackedResults[label]) {
          handleTriggerStack(label, images);
        }
      }
    });
  }, [groupedCapturedImages, settings.zStackCount, stackedResults]);
```

- [ ] **Step 2: Replace it with the extended version**

```ts
  useEffect(() => {
    (Object.entries(groupedCapturedImages) as [string, CapturedImage[]][]).forEach(([label, images]) => {
      if (images.length === settings.zStackCount) {
        if (!stackedResults[label]) {
          handleTriggerStack(label, images);
        }
        if (!depthResults[label] && !depthQueueRef.current.find(i => i.label === label)) {
          depthQueueRef.current.push({ label, images });
          drainDepthQueue();
        }
      }
    });
  }, [groupedCapturedImages, settings.zStackCount, stackedResults, depthResults, drainDepthQueue]);
```

Key changes:
- Added the depth enqueue block (`if (!depthResults[label] && ...)`).
- Added `depthResults` and `drainDepthQueue` to the dependency array.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add App.tsx
git commit -m "feat: auto-enqueue depth estimation per tile on Z-stack completion"
```

---

### Task 4: Manual smoke test

**No code changes — verification only.**

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

- [ ] **Step 2: Open the app and navigate to Config tab**

Go to `http://localhost:3000`. Set a small scan (e.g. 2×2 grid, 3 Z-slices) using simulated capture (no microscope required — the app renders a placeholder frame if no camera).

- [ ] **Step 3: Start the scan and watch the console**

Click **Start Scan**. Open the browser DevTools console. As each tile completes its Z-stack you should see log lines like:

```
DEPTH: Estimating surface topography for R0C0 using tenengrad...
```

appearing one at a time (sequential — the next tile's log should not appear until the previous one's `DEPTH:` processing finishes).

- [ ] **Step 4: Navigate to the Depth tab mid-scan**

While the scan is still running, switch to the **Depth** tab. Tiles that have finished depth estimation should already show their heatmap result without pressing "Analyze All".

- [ ] **Step 5: Verify "Analyze All" still works for re-processing**

After the scan completes, change the method dropdown to `laplacian` and click **Analyze All**. Tiles should re-process with the new method, confirming manual re-processing is unaffected.

- [ ] **Step 6: Commit smoke-test confirmation note (optional)**

If all steps passed, commit a note to the spec:

```bash
# No code change needed — only if you want to note test results
git commit --allow-empty -m "test: manual smoke test passed for auto-depth queue"
```
