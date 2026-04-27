# Adaptive Depth Tuning — Session Context

**Date:** 2026-04-26
**Branch:** master (formerly `claude/sweet-hugle-4a758b`, now merged via cherry-pick)
**Sample:** 3×3 mosaic of impact-damaged disk material, containing one convex dome and one concave crater feature in the center tile, surrounded by flat rectangular sample area.
**Z-stack:** 59 images, 100µm steps, total range 0–5.8mm. 100µm is the hardware positional limit — cannot be reduced.

## Problem

The `tenengrad_adaptive` depth method was speckling on both convex (dome) and concave (crater) features. Standard Tenengrad gave clean craters but holed-out domes; adaptive gave clean domes but speckled craters. Goal: harden the algorithm to handle both correctly on the same sample.

## Spec & Plan

- **Spec:** `docs/superpowers/specs/2026-04-24-adaptive-depth-hardening-design.md` — three-gate hardening (prominence, separation, dynamic range) on top of existing bimodal-threshold + spatial-open detector.
- **Plan:** `docs/superpowers/plans/2026-04-24-adaptive-depth-hardening.md` — six tasks, executed via subagent-driven development.

## What Was Built

All five plan tasks completed and committed to master:

| Commit | Change |
|---|---|
| `fd36cd3` | Baseline: SG filter, bimodal_spatial_radius, depthFilters service, DataProcessing component |
| `0ac35ee` | Python: prominence + separation + flatness gates in `adaptive_peak_depth` |
| `016845d` | server.ts: forward gate params to Python config |
| `780ea85` | depthService.ts: gate params in `computeDepthMap` |
| `0966816` | App.tsx: gate params in `handleTriggerDepth` |
| `2c14899` | DepthLab.tsx: Advanced Bimodality Gates UI + Strict/All-Off presets |
| `2e0bfbb` | Fix: forward Python stderr to console (gate logs were silently dropped) |
| `90db71d` | Fix: raise threshold slider 0.7→0.95, fix float32 overflow in prominence |
| `a233c02` | Add 7×7 and 9×9 spatial cleanup buttons |
| `a074201` | Add `z_smooth_sigma` UI slider (0.5–5.0, default 1.5) |

## Tuning Results — Summary Table

All runs on the same 3×3 mosaic. "Bimodal final" = pixels actually getting last-peak treatment after all gates and spatial open.

| Run | σ | Threshold | Spatial | Gates | Base bimodal | Final bimodal | Visual result |
|---|---|---|---|---|---|---|---|
| Default | 1.5 | 0.65 | 3×3 | OFF | 34.9% | 22.3% | Heavy speckle on both |
| Strict | 1.5 | 0.85 | 3×3 | Strict (0.15/3/1.5) | 16.8% | 4.7% | Dome better, crater still speckled |
| High thresh | 1.5 | 0.95 | 3×3 | Strict | 5.9% | 0.15% | ≈ standard Tenengrad |
| High σ + flatness | 5.0 | 0.91 | 9×9 | Strict | 6.0% | 0% | Pure standard Tenengrad |
| High σ no flatness | 5.0 | 0.86 | 7×7 | 0.15/3/OFF | 9.1% | 0.01% | Slight crater improvement (from smoothed argmax, not bimodality) |

## Key Findings

1. **Gates work as intended** — diagnostic logging in stderr (now forwarded) shows each gate's contribution. Prominence gate is the most effective filter.

2. **σ smoothing and dynamic-range gate fight each other** — high σ flattens curves, lowers peak-to-mean ratio, so dynamic-range gate fires on 96% of base. They overlap in purpose; use one or the other.

3. **Threshold ↑ ≈ standard Tenengrad** — user observation, mathematically correct. As threshold approaches 1.0, last-peak is applied to fewer pixels until the algorithm is indistinguishable from argmax.

4. **σ helps even without bimodal correction** — adaptive mode applies argmax to the smoothed focus curve. Even with 0 bimodal pixels surviving, this "smoothed argmax" is more stable than standard Tenengrad's raw argmax. The slight crater improvements at σ=5.0 with 231 bimodal pixels were from this effect, not from bimodal correction.

5. **Fundamental ceiling reached** — the dome's real glint bimodality and the crater's noise-driven false bimodality are statistically similar at 100µm Z steps. Per-pixel curve analysis cannot reliably distinguish them. Every parameter that cleans the crater also kills dome correction.

## Outstanding Issues / Things That Didn't Work

- **Flat-region noise** — heavy ripple/swirl patterns in the flat sample area surrounding the dome and crater. User explicitly deferred this; it's a separate problem rooted in low-contrast regions having no clean focus peak across Z.
- **Dome center speckling** — persists across all settings. The dome's bimodal region either isn't large enough to survive aggressive spatial opens, or its pixels aren't passing all the gates simultaneously.
- **`z_smooth` (global, not per-adaptive)** — exists in `compute_topomap_with_datum` and applies to all methods, but is not exposed in the UI. Different from `z_smooth_sigma` which only affects adaptive mode.

## Open Decisions / Suggested Next Steps

The session ended with two paths offered to the user:

**A) Expose `z_smooth` for standard Tenengrad** — sidestep the bimodal gating problem entirely. Standard Tenengrad with smoothed focus curves may be the best practical answer for this sample. Would require:
- Add `zSmooth` UI slider (DepthLab.tsx)
- Thread through App.tsx → depthService.ts → server.ts → depth_processor.py main()
- Pass to `compute_topomap_with_datum` (where it already exists as `z_smooth` param, default 0.0)

**B) Try permissive balanced settings** — σ=2.5, threshold=0.70, spatial 3×3, dynamic range OFF. More dome pixels survive while σ handles noise. User has not run this combination yet.

**C) Fundamentally different approach** (not yet discussed in detail):
- Region-based detection: use image intensity to detect specular highlights, then apply last-peak only to those regions instead of per-pixel statistics.
- Material profiles (deferred from original spec).
- Different focus measure for adaptive mode (Laplacian/Wavelet).

## Where to Pick Up

The user's last response indicated they wanted to switch to Opus and create this context file. They have not yet chosen between options A, B, or C above. The natural next move is asking them which direction to pursue and proceeding from there.

Pending from original plan: **Task 6 (manual verification + results notes)** was never completed in the formal sense — instead, the user did extensive ad-hoc tuning (this session). If formal sign-off is desired, results notes could be written based on the table above. Final code review and `superpowers:finishing-a-development-branch` are also not yet done.

## Key Files

- `services/depth_processor.py` — `adaptive_peak_depth()` (lines ~286–390) holds all gate logic. `compute_topomap_with_datum()` (line ~422) and `main()` (line ~580) thread params through.
- `components/DepthLab.tsx` — all UI sliders/buttons for adaptive controls. Threshold slider max is 0.95. Spatial cleanup buttons go up to 9×9. Z Curve Smoothing slider 0.5–5.0.
- `server.ts` — depth route at line ~250, config object at ~270, stderr forwarding fix at line ~313.
- `services/depthService.ts` — `computeDepthMap()` signature and POST body.
- `App.tsx` — `handleTriggerDepth()` at line ~251.

## Diagnostic Log Format

Each adaptive run prints to terminal (server stderr):

```
DEPTH_PROC: Adaptive mode: bimodal_threshold=X, spatial_radius=N, z_smooth_sigma=Y, min_prominence=P, min_separation=S, min_dynamic_range=D
DEPTH_PROC: Adaptive gates: base=N0, after_flatness=N1, after_separation=N2, after_prominence=N3 (of TOTAL total)
DEPTH_PROC: Adaptive: spatial open r=R -> NF bimodal pixels remain
```

Read this to understand which gate is doing the filtering work. Total image = 2,073,600 pixels at the current downscale.
