#!/usr/bin/env python3
import json
import os
import re
import sys
from glob import glob

import cv2
import numpy as np
from scipy.ndimage import binary_closing, binary_dilation, gaussian_filter, gaussian_filter1d


def log(msg):
    sys.stderr.write(f"SURFACE_INFERENCE: {msg}\n")
    sys.stderr.flush()


def list_images(folder):
    patterns = ("*.png", "*.jpg", "*.jpeg", "*.tif", "*.tiff", "*.bmp")
    files = []
    for pattern in patterns:
        files.extend(glob(os.path.join(folder, pattern)))

    def natkey(path):
        base = os.path.basename(path)
        return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", base)]

    files = sorted(files, key=natkey)
    capture_files = [f for f in files if os.path.basename(f).lower().startswith("img_")]
    return capture_files if capture_files else files


def read_gray(path, downscale=1.0):
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError(f"Could not read image: {path}")
    if img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if downscale and downscale > 1.0:
        size = (
            max(1, int(round(img.shape[1] / float(downscale)))),
            max(1, int(round(img.shape[0] / float(downscale)))),
        )
        img = cv2.resize(img, size, interpolation=cv2.INTER_AREA)
    return img.astype(np.float32)


def robust_normalize(im):
    lo, hi = np.percentile(im, (1.0, 99.0))
    if hi <= lo:
        return np.zeros_like(im, dtype=np.float32)
    out = (im - lo) * (255.0 / (hi - lo))
    return np.clip(out, 0.0, 255.0).astype(np.float32)


def register_to_reference(im, ref, max_shift_px=8, min_response=0.12):
    ref_small = cv2.resize(ref, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    im_small = cv2.resize(im, None, fx=0.25, fy=0.25, interpolation=cv2.INTER_AREA)
    ref_small = robust_normalize(ref_small)
    im_small = robust_normalize(im_small)
    try:
        shift, response = cv2.phaseCorrelate(ref_small, im_small)
        dx = float(shift[0] * 4.0)
        dy = float(shift[1] * 4.0)
        response = float(response)
        if (
            not np.isfinite(dx)
            or not np.isfinite(dy)
            or abs(dx) > max_shift_px
            or abs(dy) > max_shift_px
            or response < min_response
        ):
            return im, (0.0, 0.0, response if np.isfinite(response) else 0.0)
        mat = np.float32([[1, 0, dx], [0, 1, dy]])
        warped = cv2.warpAffine(
            im,
            mat,
            (im.shape[1], im.shape[0]),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REFLECT101,
        )
        return warped.astype(np.float32), (dx, dy, response)
    except Exception as exc:
        log(f"Registration warning: {exc}")
        return im, (0.0, 0.0, 0.0)


def fm_tenengrad(im):
    im_blur = cv2.GaussianBlur(im, (5, 5), 0)
    gx = cv2.Sobel(im_blur, cv2.CV_32F, 1, 0, ksize=5)
    gy = cv2.Sobel(im_blur, cv2.CV_32F, 0, 1, ksize=5)
    mag = cv2.magnitude(gx, gy)
    return cv2.GaussianBlur(mag, (5, 5), 0)


def fm_laplacian(im):
    im_blur = cv2.GaussianBlur(im, (3, 3), 0)
    lap = cv2.Laplacian(im_blur, cv2.CV_32F, ksize=3)
    return cv2.GaussianBlur(np.abs(lap), (5, 5), 0)


def robust_scale_focus(fm):
    scale = float(np.percentile(fm, 95.0))
    if scale <= 1e-6:
        scale = float(np.max(fm))
    if scale <= 1e-6:
        return np.zeros_like(fm, dtype=np.float32)
    return (fm / scale).astype(np.float32)


def normalized_gaussian(values, weights, sigma_px):
    sigma_px = max(float(sigma_px), 0.01)
    safe_values = np.where(np.isfinite(values), values, 0.0)
    safe_weights = np.where(np.isfinite(values), weights, 0.0)
    num = gaussian_filter(safe_values * safe_weights, sigma=sigma_px, mode="nearest")
    den = gaussian_filter(safe_weights, sigma=sigma_px, mode="nearest")
    return num / np.maximum(den, 1e-6)


def save_gray(path, arr, valid_mask=None, invert=False):
    data = arr.astype(np.float32)
    if valid_mask is None:
        valid_mask = np.isfinite(data)
    if np.any(valid_mask):
        lo, hi = np.percentile(data[valid_mask], (1.0, 99.0))
        if hi <= lo:
            hi = lo + 1.0
        norm = np.clip((data - lo) / (hi - lo), 0.0, 1.0)
    else:
        norm = np.zeros_like(data, dtype=np.float32)
    if invert:
        norm = 1.0 - norm
    norm[~valid_mask] = 0.0
    img = (norm * 255.0).astype(np.uint8)
    cv2.imwrite(path, img)


def save_heatmap(path, height, valid_mask, vmin, vmax):
    denom = max(vmax - vmin, 1e-6)
    norm = np.clip((height - vmin) / denom, 0.0, 1.0)
    norm[~valid_mask] = 0.0
    img = (norm * 255.0).astype(np.uint8)
    color = cv2.applyColorMap(img, cv2.COLORMAP_TURBO)
    color[~valid_mask] = (0, 0, 0)
    cv2.imwrite(path, color, [int(cv2.IMWRITE_JPEG_QUALITY), 95])


def confidence_from_focus_stack(focus_stack):
    k = np.argmax(focus_stack, axis=0).astype(np.int16)
    fmax = np.take_along_axis(focus_stack, k[None, :, :], axis=0)[0]
    fmean = np.mean(focus_stack, axis=0)
    fstd = np.std(focus_stack, axis=0)
    peak_ratio = fmax / np.maximum(fmean, 1e-6)
    z_score = (fmax - fmean) / np.maximum(fstd, 1e-6)
    p5, p95 = np.percentile(fmax, (5.0, 95.0))
    strength = np.clip((fmax - p5) / max(p95 - p5, 1e-6), 0.0, 1.0)
    shape_conf = np.clip((peak_ratio - 1.0) / 1.75, 0.0, 1.0)
    z_conf = np.clip(z_score / 3.0, 0.0, 1.0)
    confidence = np.clip(0.45 * strength + 0.35 * shape_conf + 0.20 * z_conf, 0.0, 1.0)
    return confidence


def compute_surface(config):
    image_folder = config["image_folder"]
    output_folder = config.get("output_folder", image_folder)
    os.makedirs(output_folder, exist_ok=True)

    z_step_mm = float(config.get("z_step_mm", 0.1))
    downscale = float(config.get("downscale", 1.0))
    pixel_resolution_um = float(config.get("pixel_resolution_um", 1.0))
    support_radius_um = float(config.get("surface_support_radius_um", 140.0))
    regularization_um = float(config.get("surface_regularization_um", 180.0))
    void_sensitivity = float(config.get("surface_void_sensitivity", 0.35))
    z_smooth_sigma = float(config.get("surface_z_smooth_sigma", 1.0))
    high_is_earliest = bool(config.get("high_is_earliest", False))
    do_register = bool(config.get("surface_register_stack", True))
    registration_max_shift_px = float(config.get("surface_registration_max_shift_px", 8.0))
    registration_min_response = float(config.get("surface_registration_min_response", 0.12))
    tail_suppression = config.get("surface_tail_suppression", "auto")
    tail_confidence_threshold = float(config.get("surface_tail_confidence_threshold", 0.53))

    image_files = list_images(image_folder)
    if len(image_files) < 3:
        raise ValueError("At least 3 images are required for surface inference.")

    first = read_gray(image_files[0], downscale=downscale)
    h, w = first.shape
    n = len(image_files)
    support_sigma_px = max(0.5, support_radius_um / max(pixel_resolution_um, 1e-6) / 2.5)
    reg_sigma_px = max(0.5, regularization_um / max(pixel_resolution_um, 1e-6) / 3.0)

    log(
        f"Processing {n} frames at {w}x{h}; pixel={pixel_resolution_um:.3f}um, "
        f"support_sigma={support_sigma_px:.2f}px, regularization_sigma={reg_sigma_px:.2f}px"
    )

    fm_stack = np.empty((n, h, w), dtype=np.float32)
    intensity_mean = np.zeros((h, w), dtype=np.float32)
    intensity_sq_mean = np.zeros((h, w), dtype=np.float32)
    max_intensity = np.zeros((h, w), dtype=np.float32)
    shifts = []
    ref = first

    for idx, path in enumerate(image_files):
        im = first if idx == 0 else read_gray(path, downscale=downscale)
        if do_register and idx > 0:
            im, shift = register_to_reference(
                im,
                ref,
                max_shift_px=registration_max_shift_px,
                min_response=registration_min_response,
            )
        else:
            shift = (0.0, 0.0, 1.0)
        shifts.append(shift)

        norm = robust_normalize(im)
        ten = fm_tenengrad(norm)
        lap = fm_laplacian(norm)
        fm = (ten + 0.35 * lap).astype(np.float32)
        fm = cv2.GaussianBlur(fm, (0, 0), sigmaX=support_sigma_px, sigmaY=support_sigma_px)
        fm_stack[idx] = fm

        intensity_mean += norm / n
        intensity_sq_mean += (norm * norm) / n
        max_intensity = np.maximum(max_intensity, norm)

        if idx % 10 == 0 or idx == n - 1:
            log(f"Built focus evidence for frame {idx + 1}/{n}")

    focus_scale = float(np.percentile(fm_stack, 95.0))
    if focus_scale <= 1e-6:
        focus_scale = float(np.max(fm_stack))
    if focus_scale > 1e-6:
        fm_stack = (fm_stack / focus_scale).astype(np.float32)
    log(f"Global focus scale: {focus_scale:.6f}")

    if z_smooth_sigma > 0:
        fm_stack = gaussian_filter1d(fm_stack, sigma=z_smooth_sigma, axis=0, mode="nearest")

    preliminary_confidence = confidence_from_focus_stack(fm_stack)
    preliminary_confidence_mean = float(np.mean(preliminary_confidence))
    if isinstance(tail_suppression, str):
        tail_mode = tail_suppression.lower()
        use_tail_suppression = tail_mode in ("1", "true", "yes", "on")
        if tail_mode == "auto":
            use_tail_suppression = preliminary_confidence_mean < tail_confidence_threshold
    else:
        use_tail_suppression = bool(tail_suppression)

    axial_bg_sigma = 0.0
    if use_tail_suppression:
        axial_bg_sigma = float(config.get("surface_axial_bg_sigma", max(5.0, n / 10.0)))
        axial_bg = gaussian_filter1d(fm_stack, sigma=axial_bg_sigma, axis=0, mode="nearest")
        fm_stack_raw = fm_stack
        fm_stack = np.maximum(fm_stack - axial_bg, 0.0).astype(np.float32)
        # Keep a small amount of absolute focus evidence so broad but real focus
        # on low-texture flats is not erased entirely by background subtraction.
        fm_stack += (0.08 * fm_stack_raw).astype(np.float32)

    k_raw = np.argmax(fm_stack, axis=0).astype(np.int16)
    fmax = np.take_along_axis(fm_stack, k_raw[None, :, :], axis=0)[0]
    fmean = np.mean(fm_stack, axis=0)
    fstd = np.std(fm_stack, axis=0)
    peak_ratio = fmax / np.maximum(fmean, 1e-6)
    z_score = (fmax - fmean) / np.maximum(fstd, 1e-6)

    p5, p95 = np.percentile(fmax, (5.0, 95.0))
    strength = np.clip((fmax - p5) / max(p95 - p5, 1e-6), 0.0, 1.0)
    shape_conf = np.clip((peak_ratio - 1.0) / 1.75, 0.0, 1.0)
    z_conf = np.clip(z_score / 3.0, 0.0, 1.0)
    confidence = np.clip(0.45 * strength + 0.35 * shape_conf + 0.20 * z_conf, 0.0, 1.0)

    intensity_var = np.maximum(intensity_sq_mean - intensity_mean * intensity_mean, 0.0)
    intensity_std = np.sqrt(intensity_var)
    bright_cut = max(245.0, float(np.percentile(max_intensity, 97.5)))
    flicker_cut = float(np.percentile(intensity_std, 65.0))
    glint_mask = (
        (max_intensity >= bright_cut)
        & (intensity_std >= flicker_cut)
    )
    glint_expand_px = int(max(1, round(support_sigma_px * 0.25)))
    glint_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (glint_expand_px * 2 + 1, glint_expand_px * 2 + 1),
    )
    glint_mask = cv2.dilate(glint_mask.astype(np.uint8), glint_kernel).astype(bool)

    strong_surface = confidence > max(void_sensitivity + 0.20, 0.55)
    surface_support = gaussian_filter(
        strong_surface.astype(np.float32),
        sigma=max(support_sigma_px, 1.0),
        mode="nearest",
    )
    very_low_focus = strength < 0.18
    unresolved_curve = (peak_ratio < 1.18) & (z_score < 1.15)
    unsupported_region = surface_support < 0.08
    void_mask = (
        (confidence < void_sensitivity)
        & very_low_focus
        & unresolved_curve
        & unsupported_region
        & (~glint_mask)
    )

    # Clean voids at the same physical scale as the support region.
    void_kernel_px = int(max(3, round((support_radius_um / max(pixel_resolution_um, 1e-6)) / 3.0)))
    if void_kernel_px % 2 == 0:
        void_kernel_px += 1
    void_kernel_px = min(void_kernel_px, 31)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (void_kernel_px, void_kernel_px))
    void_mask = cv2.morphologyEx(void_mask.astype(np.uint8), cv2.MORPH_OPEN, kernel).astype(bool)
    void_mask = cv2.morphologyEx(void_mask.astype(np.uint8), cv2.MORPH_CLOSE, kernel).astype(bool)

    if high_is_earliest:
        raw_height = (n - 1 - k_raw.astype(np.float32)) * z_step_mm
    else:
        raw_height = k_raw.astype(np.float32) * z_step_mm

    surface_mask = ~void_mask
    weights = np.where(surface_mask, 0.15 + 0.85 * confidence, 0.0).astype(np.float32)
    smooth_height = normalized_gaussian(raw_height, weights, reg_sigma_px)
    residual = raw_height - smooth_height
    z_step = max(z_step_mm, 1e-6)
    spike_weight = np.clip((np.abs(residual) - 0.75 * z_step) / (2.0 * z_step), 0.0, 1.0)
    low_conf_weight = np.clip(1.0 - confidence, 0.0, 1.0) ** 1.4
    glint_weight = np.where(glint_mask, 0.80, 0.0).astype(np.float32)
    blend = np.maximum(np.maximum(spike_weight, low_conf_weight), glint_weight).astype(np.float32)
    regularized = raw_height * (1.0 - blend) + smooth_height * blend

    for _ in range(2):
        cleanup_weights = np.where(surface_mask, 0.10 + 0.90 * confidence, 0.0).astype(np.float32)
        cleanup_smooth = normalized_gaussian(regularized, cleanup_weights, reg_sigma_px * 0.75)
        cleanup_residual = regularized - cleanup_smooth
        cleanup_blend = np.clip((np.abs(cleanup_residual) - 0.65 * z_step) / (1.35 * z_step), 0.0, 1.0)
        cleanup_blend = np.maximum(cleanup_blend, np.where(glint_mask, 0.70, 0.0))
        regularized = regularized * (1.0 - cleanup_blend) + cleanup_smooth * cleanup_blend

    repair_fraction = 0.0
    for _ in range(3):
        trusted = surface_mask & (~glint_mask) & (confidence > 0.45) & np.isfinite(regularized)
        broad = normalized_gaussian(
            regularized,
            trusted.astype(np.float32) * (0.20 + confidence),
            max(reg_sigma_px * 2.8, support_sigma_px * 2.0),
        )
        surface_residual = regularized - broad
        suspect = surface_mask & (
            (
                (np.abs(surface_residual) > 1.8 * z_step)
                & ((confidence < 0.68) | glint_mask)
            )
            | (np.abs(surface_residual) > 3.8 * z_step)
        )
        suspect = binary_closing(suspect, iterations=2)
        suspect = binary_dilation(suspect, iterations=2)
        repair_fraction = max(repair_fraction, float(np.mean(suspect)))
        fill = normalized_gaussian(
            regularized,
            (surface_mask & (~suspect)).astype(np.float32) * (0.15 + confidence),
            max(reg_sigma_px * 1.8, support_sigma_px * 1.4),
        )
        repair_blend = np.where(suspect, 0.85, 0.0).astype(np.float32)
        regularized = regularized * (1.0 - repair_blend) + fill * repair_blend

    confidence_mean = float(np.mean(confidence))
    use_multiscale_repair = confidence_mean < 0.53 or repair_fraction > 0.55
    multiscale_repair_fraction = 0.0
    if use_multiscale_repair:
        low_conf_region = surface_mask & (confidence < 0.46)
        low_conf_region = binary_closing(low_conf_region, iterations=2)
        anchor = surface_mask & (~low_conf_region) & (~glint_mask) & (confidence > 0.58)
        anchor_support = gaussian_filter(
            anchor.astype(np.float32),
            sigma=max(reg_sigma_px * 3.5, support_sigma_px * 2.5),
            mode="nearest",
        )
        coarse_surface = normalized_gaussian(
            regularized,
            anchor.astype(np.float32) * (0.10 + confidence),
            max(reg_sigma_px * 4.5, support_sigma_px * 3.5),
        )
        medium_surface = normalized_gaussian(
            regularized,
            (surface_mask & (~glint_mask) & (confidence > 0.38)).astype(np.float32) * (0.10 + confidence),
            max(reg_sigma_px * 2.3, support_sigma_px * 1.8),
        )
        multiscale_surface = np.where(anchor_support > 0.025, coarse_surface, medium_surface)
        low_conf_residual = regularized - multiscale_surface
        low_conf_blend = np.clip((0.56 - confidence) / 0.30, 0.0, 1.0)
        low_conf_blend = np.maximum(low_conf_blend, np.where(glint_mask & (confidence < 0.62), 0.82, 0.0))
        low_conf_blend = np.maximum(
            low_conf_blend,
            np.where(np.abs(low_conf_residual) > 2.8 * z_step, 0.70, 0.0),
        )
        low_conf_blend = np.where(surface_mask, low_conf_blend, 0.0).astype(np.float32)
        multiscale_repair_fraction = float(np.mean(low_conf_blend > 0.25))
        regularized = regularized * (1.0 - low_conf_blend) + multiscale_surface * low_conf_blend

    regularized[void_mask] = np.nan

    valid = np.isfinite(regularized)
    if not np.any(valid):
        raise ValueError("Surface inference classified all pixels as void; lower void sensitivity.")

    vmin = float(np.nanmin(regularized))
    vmax = float(np.nanmax(regularized))
    if vmax <= vmin:
        vmax = vmin + z_step_mm

    save_heatmap(os.path.join(output_folder, "heatmap.jpg"), regularized, valid, vmin, vmax)
    save_heatmap(os.path.join(output_folder, "surface_inference_depth.jpg"), regularized, valid, vmin, vmax)
    save_heatmap(os.path.join(output_folder, "raw_argmax_depth.jpg"), raw_height, np.ones_like(valid), float(np.min(raw_height)), float(np.max(raw_height)))
    save_gray(os.path.join(output_folder, "confidence_map.png"), confidence)
    save_gray(os.path.join(output_folder, "focus_strength_map.png"), strength)
    save_gray(os.path.join(output_folder, "void_mask.png"), void_mask.astype(np.float32))
    save_gray(os.path.join(output_folder, "glint_mask.png"), glint_mask.astype(np.float32))
    save_gray(os.path.join(output_folder, "selected_z_map.png"), k_raw.astype(np.float32))

    np.save(os.path.join(output_folder, "depth_regularized_mm.npy"), regularized.astype(np.float32))
    np.save(os.path.join(output_folder, "depth_raw_mm.npy"), raw_height.astype(np.float32))
    np.save(os.path.join(output_folder, "confidence.npy"), confidence.astype(np.float32))
    np.save(os.path.join(output_folder, "void_mask.npy"), void_mask.astype(np.uint8))
    np.save(os.path.join(output_folder, "glint_mask.npy"), glint_mask.astype(np.uint8))

    diagnostics = {
        "frames": n,
        "width": w,
        "height": h,
        "pixel_resolution_um": pixel_resolution_um,
        "z_step_mm": z_step_mm,
        "support_sigma_px": support_sigma_px,
        "regularization_sigma_px": reg_sigma_px,
        "focus_scale": focus_scale,
        "axial_bg_sigma": axial_bg_sigma,
        "tail_suppression_enabled": bool(use_tail_suppression),
        "preliminary_confidence_mean": preliminary_confidence_mean,
        "tail_confidence_threshold": tail_confidence_threshold,
        "glint_bright_cut": bright_cut,
        "glint_flicker_cut": flicker_cut,
        "void_fraction": float(np.mean(void_mask)),
        "glint_fraction": float(np.mean(glint_mask)),
        "surface_repair_fraction": repair_fraction,
        "multiscale_repair_enabled": bool(use_multiscale_repair),
        "multiscale_repair_fraction": multiscale_repair_fraction,
        "confidence_mean": confidence_mean,
        "confidence_p10": float(np.percentile(confidence, 10.0)),
        "confidence_p50": float(np.percentile(confidence, 50.0)),
        "confidence_p90": float(np.percentile(confidence, 90.0)),
        "registration_shifts": [
            {"dx": dx, "dy": dy, "response": response}
            for dx, dy, response in shifts
        ],
    }
    with open(os.path.join(output_folder, "surface_inference_diagnostics.json"), "w", encoding="utf-8") as f:
        json.dump(diagnostics, f, indent=2)

    export_height = regularized.copy()
    export_height[~valid] = -0.001
    return {
        "width": int(w),
        "height": int(h),
        "depthValues": export_height.flatten().astype(float).tolist(),
        "minZ": vmin,
        "maxZ": vmax,
        "diagnostics": diagnostics,
    }


def main():
    try:
        if len(sys.argv) < 2:
            print(json.dumps({"error": "Usage: surface_inference.py <config.json>"}))
            sys.exit(1)
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            config = json.load(f)
        result = compute_surface(config)
        print("---JSON_START---")
        print(json.dumps(result))
        print("---JSON_END---")
        sys.stdout.flush()
    except Exception as exc:
        log(f"FATAL ERROR: {exc}")
        import traceback

        log(traceback.format_exc())
        print("---JSON_START---")
        print(json.dumps({"error": str(exc)}))
        print("---JSON_END---")
        sys.exit(1)


if __name__ == "__main__":
    main()
