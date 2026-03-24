#!/usr/bin/env python3
import os, time, re, sys, json, base64
from glob import glob
import numpy as np
import cv2
import pywt
from scipy.ndimage import median_filter, gaussian_filter

def log(msg):
    sys.stderr.write(f"DEPTH_PROC: {msg}\n")
    sys.stderr.flush()

# ---------------------- Helpers: file + image I/O ---------------------- #

def list_images(folder):
    patterns = ('*.png', '*.jpg', '*.jpeg', '*.tif', '*.tiff', '*.bmp')
    files = []
    for p in patterns:
        files.extend(glob(os.path.join(folder, p)))

    def _natkey(s):
        base = os.path.basename(s)
        return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', base)]

    return sorted(files, key=_natkey)


def read_gray_f32(path, downscale=1.0):
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ValueError(f"Could not read image: {path}")
    if img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if downscale and downscale > 1.0:
        new_size = (
            int(round(img.shape[1] / downscale)),
            int(round(img.shape[0] / downscale)),
        )
        new_size = (max(new_size[0], 1), max(new_size[1], 1))
        img = cv2.resize(img, new_size, interpolation=cv2.INTER_AREA)
    return img.astype(np.float32)


# ---------------------- Preprocessing & focus measures ---------------------- #

def preprocess_image(im, mode='none', lcn_ksize=15, clahe_clip=2.0, clahe_tile=8):
    if mode == 'none':
        return im

    if mode == 'clahe':
        im8 = np.clip(im, 0, 255).astype(np.uint8)
        clahe = cv2.createCLAHE(
            clipLimit=float(clahe_clip),
            tileGridSize=(int(clahe_tile), int(clahe_tile))
        )
        return clahe.apply(im8).astype(np.float32)

    if mode == 'lcn':
        k = max(3, int(lcn_ksize) // 2 * 2 + 1)
        mu = cv2.blur(im, (k, k))
        mu2 = cv2.blur(im * im, (k, k))
        var = np.maximum(mu2 - mu * mu, 1e-6)
        std = np.sqrt(var)
        lcn = (im - mu) / std
        lcn = lcn - np.min(lcn)
        m = np.max(lcn)
        if m > 0:
            lcn = lcn * (255.0 / m)
        return lcn.astype(np.float32)

    return im


def fm_wavelet(im):
    wavelet_family = 'db4'
    coeffs = pywt.dwt2(im, wavelet_family)
    LL, (LH, HL, HH) = coeffs
    energy_map_small = np.abs(LH) + np.abs(HL) + np.abs(HH)
    energy_map = np.repeat(np.repeat(energy_map_small, 2, axis=0), 2, axis=1)
    # Ensure it matches the original image shape exactly (in case of odd dimensions)
    if energy_map.shape != im.shape:
        energy_map = cv2.resize(energy_map, (im.shape[1], im.shape[0]))
    return energy_map


def fm_laplacian(im):
    # Modified Laplacian (ML) with a larger kernel for robustness
    # We use a 5x5 area to be less sensitive to pixel noise
    im_blur = cv2.GaussianBlur(im, (3, 3), 0)
    kernel_x = np.array([
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
        [-1, 0, 2, 0, -1],
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0]
    ], dtype=np.float32)
    kernel_y = kernel_x.T
    
    lx = cv2.filter2D(im_blur, cv2.CV_32F, kernel_x)
    ly = cv2.filter2D(im_blur, cv2.CV_32F, kernel_y)
    
    return np.abs(lx) + np.abs(ly)


def fm_tenengrad(im):
    # Apply a larger blur for 4K/high-res robustness
    im_blur = cv2.GaussianBlur(im, (5, 5), 0)
    gx = cv2.Sobel(im_blur, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(im_blur, cv2.CV_32F, 0, 1, ksize=3)
    # Tenengrad magnitude
    return np.sqrt(gx**2 + gy**2)


def make_circular_kernel(radius):
    r = int(radius)
    if r <= 0:
        return np.ones((1, 1), np.float32)
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    mask = (x * x + y * y) <= r * r
    ker = mask.astype(np.float32)
    ker /= ker.sum()
    return ker


# ---------------------- FAST Gaussian fit in depth per pixel ---------------------- #

def _inv3x3_times_vec(M00, M01, M02, M10, M11, M12, M20, M21, M22, v0, v1, v2):
    c00 = (M11 * M22 - M12 * M21)
    c01 = -(M10 * M22 - M12 * M20)
    c02 = (M10 * M21 - M11 * M20)

    c10 = -(M01 * M22 - M02 * M21)
    c11 = (M00 * M22 - M02 * M20)
    c12 = -(M00 * M21 - M01 * M20)

    c20 = (M01 * M12 - M02 * M11)
    c21 = -(M00 * M12 - M02 * M10)
    c22 = (M00 * M11 - M01 * M10)

    det = M00 * c00 + M01 * c01 + M02 * c02

    x0 = (c00 * v0 + c10 * v1 + c20 * v2) / det
    x1 = (c01 * v0 + c11 * v1 + c21 * v2) / det
    x2 = (c02 * v0 + c12 * v1 + c22 * v2) / det
    return x0, x1, x2, det


def gaussian_fit_per_pixel_fast(
    focus_stack,
    depths,
    eligibility_mask=None,
    window_size=2,
    min_points=3,
    min_frac_of_peak=0.3
):
    N, H, W = focus_stack.shape
    depths = np.asarray(depths, dtype=np.float32)

    k_max = np.argmax(focus_stack, axis=0).astype(np.int32)
    F_max = np.max(focus_stack, axis=0).astype(np.float32)

    offsets = np.arange(-int(window_size), int(window_size) + 1, dtype=np.int32)
    M = offsets.size

    idxs = k_max[None, :, :] + offsets[:, None, None]
    idxs = np.clip(idxs, 0, N - 1)

    F_win = np.take_along_axis(focus_stack, idxs, axis=0)
    d_win = depths[idxs]

    thresh = (min_frac_of_peak * F_max)[None, :, :]
    mask = (F_win >= thresh) & np.isfinite(F_win) & (F_win > 0)

    if eligibility_mask is not None:
        mask &= eligibility_mask[None, :, :]

    w = mask.astype(np.float32)
    count = w.sum(axis=0)

    y = np.log(F_win + 1e-12).astype(np.float32)

    d = d_win.astype(np.float32)
    d2 = d * d
    d3 = d2 * d
    d4 = d2 * d2

    S0 = (w).sum(axis=0)
    S1 = (w * d).sum(axis=0)
    S2 = (w * d2).sum(axis=0)
    S3 = (w * d3).sum(axis=0)
    S4 = (w * d4).sum(axis=0)

    T0 = (w * y).sum(axis=0)
    T1 = (w * d * y).sum(axis=0)
    T2 = (w * d2 * y).sum(axis=0)

    lam = np.float32(1e-6)
    M00, M01, M02 = S4 + lam, S3,       S2
    M10, M11, M12 = S3,       S2 + lam, S1
    M20, M21, M22 = S2,       S1,       S0 + lam

    a, b, c, det = _inv3x3_times_vec(
        M00, M01, M02, M10, M11, M12, M20, M21, M22,
        T2,  T1,  T0
    )

    valid = (count >= float(min_points)) & np.isfinite(a) & np.isfinite(b) & np.isfinite(c) & np.isfinite(det)
    valid &= (np.abs(det) > 1e-12)
    valid &= (a < 0)

    mu_map = np.full((H, W), np.nan, dtype=np.float32)
    sigma_map = np.full((H, W), np.nan, dtype=np.float32)
    fpeak_map = F_max.copy()

    mu = (-b / (2.0 * a)).astype(np.float32)
    sigma_sq = (-1.0 / (2.0 * a)).astype(np.float32)

    d_min = float(np.min(depths))
    d_max = float(np.max(depths))
    mu = np.clip(mu, d_min, d_max)

    sigma = np.sqrt(np.maximum(sigma_sq, 0.0)).astype(np.float32)

    mu_map[valid] = mu[valid]
    sigma_map[valid] = sigma[valid]

    max_log_f32 = np.log(np.finfo(np.float32).max)
    exp_arg = (c - (b * b) / (4.0 * a)).astype(np.float32)
    exp_ok = valid & np.isfinite(exp_arg) & (exp_arg <= max_log_f32)

    if np.any(exp_ok):
        F_peak = np.exp(exp_arg[exp_ok]).astype(np.float32)
        F_peak = np.where(
            np.isfinite(F_peak) & (F_peak > 0) & (F_peak <= 10.0 * F_max[exp_ok]),
            F_peak,
            F_max[exp_ok]
        )
        fpeak_map[exp_ok] = F_peak

    fb = (~valid) & np.isfinite(F_max) & (F_max > 0)
    if np.any(fb):
        mu_map[fb] = depths[k_max[fb]]

    return mu_map, sigma_map, fpeak_map


import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ---------------------- Main topography computation ---------------------- #

def compute_topomap_with_datum(
    image_files,
    z_step_mm,
    method='laplacian',
    downscale=1.0,
    median_size=3,
    gauss_sigma=0.0,
    preprocess='none',
    lcn_ksize=15,
    clahe_clip=2.0,
    clahe_tile=8,
    z_smooth=0.0,
    first_hit_fraction=0.8,
    support_radius_px=5,
    support_fraction=0.8,
    min_global_fraction=0.2,
    high_is_earliest=False, # Flipped by default
    depths=None
):
    if not image_files:
        raise ValueError("No images found in the folder.")

    first = read_gray_f32(image_files[0], downscale=downscale)
    h, w = first.shape
    n = len(image_files)

    if depths is None:
        depths = np.arange(n, dtype=np.float32) * float(z_step_mm)
    else:
        depths = np.asarray(depths, dtype=np.float32)
        if depths.size < n:
            raise ValueError("Depth array has fewer entries than images.")
        depths = depths[:n]

    fm_stack = np.zeros((n, h, w), dtype=np.float32)
    
    if method == 'wavelet' or method == 'wav1':
        fm_func = fm_wavelet
    elif method == 'tenengrad':
        fm_func = fm_tenengrad
    else:
        fm_func = fm_laplacian

    for i, path in enumerate(image_files):
        im = read_gray_f32(path, downscale=downscale)
        im = preprocess_image(
            im,
            mode=preprocess,
            lcn_ksize=lcn_ksize,
            clahe_clip=clahe_clip,
            clahe_tile=clahe_tile
        )
        fm = fm_func(im)
        if median_size and median_size > 1:
            fm = median_filter(fm, size=median_size)
        if gauss_sigma and gauss_sigma > 0:
            fm = gaussian_filter(fm, sigma=gauss_sigma)
        fm_stack[i] = fm

    if z_smooth and z_smooth > 0.0:
        fm_stack = gaussian_filter(fm_stack, sigma=(z_smooth, 0.0, 0.0))

    fmax = np.max(fm_stack, axis=0)
    # Relaxed eligibility: use a lower percentile for the threshold
    global_thresh_base = float(np.percentile(fmax, 10)) # 10th percentile
    global_median = float(np.median(fmax))
    eligibility_thresh = max(global_median * float(min_global_fraction), global_thresh_base, 1e-9)
    base_eligible = (fmax >= eligibility_thresh)

    ker = make_circular_kernel(int(round(support_radius_px)))
    support = cv2.filter2D(
        base_eligible.astype(np.float32),
        -1,
        ker,
        borderType=cv2.BORDER_REPLICATE
    )
    # Relaxed support requirement
    eligible = base_eligible & (support >= float(support_fraction * 0.5))

    mu_map, sigma_map, fpeak_map = gaussian_fit_per_pixel_fast(
        fm_stack,
        depths,
        eligibility_mask=eligible,
        window_size=2,
        min_points=3,
        min_frac_of_peak=float(first_hit_fraction)
    )

    height = np.full((h, w), np.nan, dtype=np.float32)
    valid = np.isfinite(mu_map)
    if np.any(valid):
        d_min = float(np.min(depths))
        d_max = float(np.max(depths))
        if high_is_earliest:
            height[valid] = d_max - mu_map[valid]
        else:
            height[valid] = mu_map[valid] - d_min

    return height, mu_map, fpeak_map


# ---------------------- CLI Interface ---------------------- #

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 depth_processor.py <input_json_path>")
        sys.exit(1)

    json_path = sys.argv[1]
    with open(json_path, 'r') as f:
        config = json.load(f)

    image_folder = config['image_folder']
    z_step_mm = config.get('z_step_mm', 0.1)
    method = config.get('method', 'laplacian')
    downscale = config.get('downscale', 1.0)
    depths = config.get('depths', None)
    pixel_resolution_um = config.get('pixel_resolution_um', 1.0)
    
    # Advanced params
    preprocess = config.get('preprocess', 'clahe')
    first_hit_fraction = config.get('first_hit_fraction', 0.8)
    support_radius_px = config.get('support_radius_px', 1)
    support_fraction = config.get('support_fraction', 0.8)
    min_global_fraction = config.get('min_global_fraction', 0.2)
    high_is_earliest = config.get('high_is_earliest', False)

    image_files = list_images(image_folder)
    log(f"Found {len(image_files)} images in {image_folder}")
    
    log(f"Computing topography using {method}...")
    height, mu, fpeak = compute_topomap_with_datum(
        image_files,
        z_step_mm=z_step_mm,
        method=method,
        downscale=downscale,
        depths=depths,
        preprocess=preprocess,
        first_hit_fraction=first_hit_fraction,
        support_radius_px=support_radius_px,
        support_fraction=support_fraction,
        min_global_fraction=min_global_fraction,
        high_is_earliest=high_is_earliest
    )
    log("Topography computation complete.")

    # Convert height map to heatmap image with colorbar and scale bar
    valid = np.isfinite(height)
    if not np.any(valid):
        log("WARNING: No valid depth points found. Falling back to raw max-focus indices.")
        # Fallback: just use the raw max indices if Gaussian fit failed everywhere
        k_max = np.argmax(fm_stack, axis=0)
        height = k_max.astype(np.float32) * float(z_step_mm)
        valid = np.ones_like(height, dtype=bool)

    vmin = float(np.nanmin(height))
    vmax = float(np.nanmax(height))
    
    if vmin == vmax:
        vmax = vmin + 0.001
    
    log(f"Generating heatmap plot (vmin={vmin:.3f}, vmax={vmax:.3f})...")
    # Create plot
    try:
        plt.figure(figsize=(12, 10))
        
        # Use viridis (standard) so high is warm/yellow and low is cool/purple
        plt.imshow(height, cmap='viridis', vmin=vmin, vmax=vmax)
        
        # Add colorbar
        cbar = plt.colorbar()
        cbar.set_label('Height (mm)', rotation=270, labelpad=15, fontsize=12, fontweight='bold')
        
        # Add X/Y axis labels in mm
        h_img, w_img = height.shape
        # pixel_resolution_um is microns per pixel
        width_mm = (w_img * pixel_resolution_um) / 1000.0
        height_mm = (h_img * pixel_resolution_um) / 1000.0
        
        plt.xlabel('Width (mm)', fontsize=12, fontweight='bold')
        plt.ylabel('Height (mm)', fontsize=12, fontweight='bold')
        
        # Set ticks to mm
        num_ticks = 5
        x_ticks = np.linspace(0, w_img - 1, num_ticks)
        x_labels = [f"{x * pixel_resolution_um / 1000.0:.2f}" for x in x_ticks]
        plt.xticks(x_ticks, x_labels)
        
        y_ticks = np.linspace(0, h_img - 1, num_ticks)
        y_labels = [f"{y * pixel_resolution_um / 1000.0:.2f}" for y in y_ticks]
        plt.yticks(y_ticks, y_labels)
        
        # Add scale bar
        # Let's add a 1mm scale bar
        scale_bar_mm = 1.0
        if width_mm < 2.0: scale_bar_mm = 0.5
        if width_mm < 0.5: scale_bar_mm = 0.1
        
        scale_bar_px = (scale_bar_mm * 1000) / pixel_resolution_um
        
        # Draw scale bar in bottom right
        bar_x = w_img - scale_bar_px - 40
        bar_y = h_img - 40
        if scale_bar_px < w_img:
            plt.plot([bar_x, bar_x + scale_bar_px], [bar_y, bar_y], color='white', linewidth=4)
            plt.text(bar_x + scale_bar_px/2, bar_y - 10, f'{scale_bar_mm} mm', color='white', ha='center', fontsize=14, fontweight='bold')
        
        # Save result image
        output_image_path = os.path.join(image_folder, 'heatmap.jpg')
        plt.tight_layout()
        plt.savefig(output_image_path, dpi=100, bbox_inches='tight', pad_inches=0.5)
        plt.close('all')
        log("Heatmap plot saved.")
    except Exception as e:
        log(f"ERROR during plotting: {str(e)}")
        # Create a blank image if plotting fails to avoid breaking the pipeline
        try:
            from PIL import Image
            blank = Image.new('RGB', (800, 600), color=(73, 109, 137))
            blank.save(os.path.join(image_folder, "heatmap.jpg"))
        except:
            pass
    
    # Prepare result JSON
    result = {
        'width': height.shape[1],
        'height': height.shape[0],
        'depthValues': height.flatten().tolist(),
        'minZ': vmin,
        'maxZ': vmax
    }
    
    print(json.dumps(result))
    sys.stdout.flush()

if __name__ == "__main__":
    main()
