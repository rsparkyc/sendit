"""Re-encode downloaded public-domain global maps into the textures the viewer ships.

Usage: python3 -I scripts/make-planet-textures.py <download-dir> <out-dir>

<download-dir> holds the source files listed in SOURCES (see src/assets/planets/CREDITS.md for
where each came from). They are treated as untrusted data: only decoded as images by Pillow,
never executed. For every body this:
  1. decodes the map (large uncompressed GeoTIFFs are memory-mapped and box-averaged),
  2. rolls it horizontally so the left edge is 0 deg east longitude and east increases to the right
     (the convention body-visuals.ts expects: u = east longitude / 360, v = (lat + 90) / 180),
     using the ISIS map label (CenterLongitude, LongitudeDirection, UpperLeftCornerX, radius),
  3. fills no-data pixels (value 0 in every band, i.e. never imaged) with the mean of the imaged
     pixels: a flat neutral tone, no invented detail,
  4. writes each tier at the sizes in TIERS with the format and quality chosen in ENCODE.
It prints bytes per file and an SSIM figure against the unencoded resample.
"""
import io, json, os, re, subprocess, sys, tempfile

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

TIERS = {'lo': 512, 'hi': 2048}  # width; height = width / 2

# id: (file, label or None, east longitude of the left edge if no label, fill no-data?)
SOURCES = {
    'earth': ('nasa/world.topo.bathy.200404.3x5400x2700.jpg', None, -180.0, False),
    'earth-night': ('nasa/BlackMarble_2016_01deg.jpg', None, -180.0, False),
    'moon': ('nasa/lroc_color_poles_4k.tif', None, -180.0, False),
    'mercury': ('usgs/Mercury_MESSENGER_mosaic_global_250m_2013.tif', 'lbl', None, True),
    'mars': ('usgs/Mars_Viking_ClrMosaic_global_925m.tif', 'lbl', None, True),
    'jupiter': ('nasa/PIA07782.jpg', None, 0.0, False),
    'io': ('usgs/Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif', 'lbl', None, True),
    'europa': ('usgs/Europa_Voyager_GalileoSSI_global_mosaic_500m.tif', 'lbl', None, True),
    'ganymede': ('usgs/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif', 'lbl', None, True),
    'callisto': ('usgs/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif', 'lbl', None, True),
    'titan': ('usgs/Titan_ISS_P19658_Mosaic_Global_4km.tif', 'lbl', None, True),
    'tethys': ('usgs/Tethys_Cassini_mosaic_global_293m.tif', 'lbl', None, True),
    'dione': ('usgs/Dione_Cassini_Voyager_mosaic_global_154m.tif', 'lbl', None, True),
    'rhea': ('usgs/Rhea_Cassini_Voyager_mosaic_global_417m.tif', 'lbl', None, True),
    'iapetus': ('usgs/Iapetus_Cassini_Voyager_mosaic_global_783m.tif', 'lbl', None, True),
    'triton': ('usgs/Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif', 'lbl', None, True),
    'pluto': ('usgs/Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif', 'lbl', None, True),
    'charon': ('usgs/Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif', 'lbl', None, True),
}
# (format, quality): chosen from the measurements printed by --survey (see CREDITS.md).
# WebP beat JPEG at equal SSIM on every map surveyed (e.g. Moon hi: WebP q85 287 kB / SSIM 0.952 vs
# JPEG q85 357 kB / 0.947), so every tier is WebP. q80 by default; the noisy, high-frequency grey
# Saturnian-moon maps keep SSIM >= 0.95 at much lower quality, so they get less.
ENCODE = {'lo': ('webp', 80), 'hi': ('webp', 80)}
QUALITY_OVERRIDE = {('tethys', 'hi'): 70, ('dione', 'hi'): 70, ('iapetus', 'hi'): 70, ('rhea', 'hi'): 75, ('mercury', 'hi'): 70}
# Bodies under ~800 km radius whose source maps are mostly noise/airbrush at 2048 px: 1024 px high tier.
HI_WIDTH = {'tethys': 1024, 'dione': 1024, 'rhea': 1024, 'iapetus': 1024}
NIGHT_TIERS = {'hi': 1024}  # night lights: one tier, loaded with Earth's high tier


def left_edge_east(lbl_path):
    t = open(lbl_path).read()
    m = t[t.find('Group = Mapping'):]
    g = lambda k: float(re.search(k + r'\s*=\s*([-0-9.eE]+)', m).group(1))
    direction = re.search(r'LongitudeDirection\s*=\s*(\w+)', m).group(1)
    dx = np.degrees(g('UpperLeftCornerX') / g('EquatorialRadius'))
    clon = g('CenterLongitude')
    return clon + dx if direction == 'PositiveEast' else dx - clon


def load(path, target_w):
    """Decode and box-average to about target_w x target_w/2 (keeping full rows and columns)."""
    im = Image.open(path)
    w, h = im.size
    f = max(1, w // target_w)
    tile = im.tile
    if f > 1 and len(tile) >= 1 and all(t[0] == 'raw' for t in tile) and im.mode in ('L', 'RGB'):
        # Uncompressed strips: if they are contiguous, memory-map instead of decoding 1-4 GB.
        bands = len(im.mode)
        offs = sorted(t[2] for t in tile)
        start = offs[0]
        planar = im.tag_v2.get(284, 1) == 2
        if not planar:
            a = np.memmap(path, dtype=np.uint8, mode='r', offset=start, shape=(h, w, bands))
        else:
            a = np.memmap(path, dtype=np.uint8, mode='r', offset=start, shape=(bands, h, w)).transpose(1, 2, 0)
        hh, ww = (h // f) * f, (w // f) * f
        out = np.zeros((hh // f, ww // f, bands), np.float64)
        valid = np.zeros((hh // f, ww // f), np.float64)
        for r0 in range(0, hh, f * 64):
            blk = np.asarray(a[r0:r0 + f * 64, :ww], dtype=np.float64)
            rows = blk.shape[0] // f
            blk = blk[:rows * f].reshape(rows, f, ww // f, f, bands)
            ok = (blk.max(axis=4) > 0).astype(np.float64)
            out[r0 // f:r0 // f + rows] = (blk * ok[..., None]).sum(axis=(1, 3))
            valid[r0 // f:r0 // f + rows] = ok.sum(axis=(1, 3))
        img = np.where(valid[..., None] > 0, out / np.maximum(valid, 1)[..., None], 0)
        return img, valid > 0
    im = im.convert('RGB') if im.mode not in ('L', 'RGB') else im
    a = np.asarray(im, dtype=np.float64)
    if a.ndim == 2:
        a = a[..., None]
    return a, a.max(axis=2) > 0


def resample(a, w, h):
    """Area resample (via Pillow, per band, float)."""
    bands = [np.asarray(Image.fromarray(a[..., b].astype(np.float32), 'F').resize((w, h), Image.BOX)) for b in range(a.shape[2])]
    return np.stack(bands, axis=2)


def ssim(x, y):
    """Mean SSIM of luma over 8x8 blocks (enough to rank encodings)."""
    def luma(a):
        return a.mean(axis=2) if a.ndim == 3 else a
    x, y = luma(x.astype(np.float64)), luma(y.astype(np.float64))
    h, w = (x.shape[0] // 8) * 8, (x.shape[1] // 8) * 8
    bx = x[:h, :w].reshape(h // 8, 8, w // 8, 8)
    by = y[:h, :w].reshape(h // 8, 8, w // 8, 8)
    mx, my = bx.mean(axis=(1, 3)), by.mean(axis=(1, 3))
    vx, vy = bx.var(axis=(1, 3)), by.var(axis=(1, 3))
    cxy = ((bx - mx[:, None, :, None]) * (by - my[:, None, :, None])).mean(axis=(1, 3))
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    return float((((2 * mx * my + c1) * (2 * cxy + c2)) / ((mx ** 2 + my ** 2 + c1) * (vx + vy + c2))).mean())


def encode(arr, fmt, q):
    im = Image.fromarray(arr.squeeze() if arr.shape[2] == 1 else arr)
    if fmt == 'jpg':
        b = io.BytesIO()
        im.save(b, 'JPEG', quality=q, optimize=True, progressive=True, subsampling=0 if q >= 90 else 2)
        return b.getvalue()
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, 'a.png'), os.path.join(d, 'a.webp')
        im.save(src)
        subprocess.run(['cwebp', '-quiet', '-q', str(q), '-m', '6', '-sharp_yuv', src, '-o', dst], check=True)
        return open(dst, 'rb').read()


def decode(b):
    a = np.asarray(Image.open(io.BytesIO(b)).convert('RGB'), dtype=np.float64)
    return a


def main():
    src_dir, out_dir = sys.argv[1], sys.argv[2]
    survey = '--survey' in sys.argv
    only = [a for a in sys.argv[3:] if not a.startswith('--')]
    os.makedirs(out_dir, exist_ok=True)
    report = {}
    for body, (file, lbl, edge, fill) in SOURCES.items():
        if only and body not in only:
            continue
        path = os.path.join(src_dir, file)
        if not os.path.exists(path):
            print(f'{body}: missing {file}, skipped')
            continue
        a, valid = load(path, 4096)
        if lbl:
            edge = left_edge_east(os.path.splitext(path)[0] + '.lbl')
        tiers = NIGHT_TIERS if body == 'earth-night' else {**TIERS, 'hi': HI_WIDTH.get(body, TIERS['hi'])}
        top = max(tiers.values())
        a = resample(a, top, top // 2)
        v = np.asarray(Image.fromarray((valid * 255).astype(np.uint8)).resize((top, top // 2), Image.BOX)) > 127
        if fill and not v.all():
            mean = a[v].mean(axis=0)
            a[~v] = mean
            print(f'{body}: filled {100 * (1 - v.mean()):.1f}% never-imaged pixels with neutral {np.round(mean).astype(int).tolist()}')
        # Roll so column 0 is at 0 deg east: column c covers east longitude edge + 360 (c + 0.5) / W.
        shift = int(round(((edge % 360) / 360) * top))
        a = np.roll(a, shift, axis=1)
        for tier, w in tiers.items():
            arr = np.clip(np.rint(resample(a, w, w // 2) if w != top else a), 0, 255).astype(np.uint8)
            if arr.shape[2] == 1:
                arr = np.repeat(arr, 3, axis=2)
            if survey:
                for fmt, qs in (('jpg', (70, 80, 85, 90)), ('webp', (70, 80, 85, 90))):
                    for q in qs:
                        b = encode(arr, fmt, q)
                        print(f'  survey {body} {tier} {fmt} q{q}: {len(b):>8} B  ssim {ssim(arr, decode(b)):.4f}')
            fmt, q = ENCODE[tier]
            q = QUALITY_OVERRIDE.get((body, tier), q)
            b = encode(arr, fmt, q)
            name = f'{body}-{tier}.{fmt}'
            open(os.path.join(out_dir, name), 'wb').write(b)
            report[name] = {'bytes': len(b), 'ssim': round(ssim(arr, decode(b)), 4), 'size': [w, w // 2]}
            print(f'{name}: {len(b)} B, ssim {report[name]["ssim"]}, left edge was {edge:.2f} E')
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
