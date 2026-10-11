// Every image the admin uploads goes through here first and is stored as WebP (or JPEG in a
// browser that can't encode WebP), as small as it can be without a visible loss:
//   1. resize so the longest side is at most 1920px (larger than any listing display) and
//      encode once at a fixed "visually lossless" quality (WebP 0.75 / JPEG 0.78) — most
//      photos come out around 30–70 KB, simple images and logos far less;
//   2. only if that is still over the 100 KB hard limit (very detailed pictures), search for
//      the highest quality ≤ that level which fits, then shrink the dimensions down to 1000px,
//      allow quality down to 0.4, and finally shrink further — so 100 KB always holds.
//
// SVGs are left alone (vector, already small); GIFs are converted to a still image.

const DEFAULTS = {
  targetBytes: 100 * 1024,   // hard upper limit, never exceeded
  quality: { 'image/webp': 0.75, 'image/jpeg': 0.78 },   // the normal, visually lossless level
  maxDimension: 1920,   // longest side — larger than any listing display
  minDimension: 1000,   // preferred floor: shrink below this only when quality 0.4 can't fit
  floorDimension: 320,  // absolute floor; quality is lowered further rather than going smaller
  minQuality: 0.6,      // quality floor before resorting to smaller dimensions
  hardMinQuality: 0.4   // quality used once dimensions reach minDimension
};
export const IMAGE_TARGET_BYTES = DEFAULTS.targetBytes;

export function isCompressibleImage(file) {
  return !!file && /^image\//.test(file.type) && file.type !== 'image/svg+xml';
}

function encode(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function decode(file) {
  // createImageBitmap applies EXIF orientation, so phone photos don't come out sideways.
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Highest quality in [lo, hi] whose encoded size fits targetBytes, or null if even lo doesn't.
async function bestQualityThatFits(canvas, type, targetBytes, lo, hi) {
  const atLo = await encode(canvas, type, lo);
  if (!atLo || atLo.size > targetBytes) return null;
  let best = atLo;
  const atHi = await encode(canvas, type, hi);
  if (atHi && atHi.size <= targetBytes) return atHi;
  for (let i = 0; i < 6; i++) {           // ~1.5% quality resolution
    const mid = (lo + hi) / 2;
    const blob = await encode(canvas, type, mid);
    if (blob && blob.size <= targetBytes) { best = blob; lo = mid; } else { hi = mid; }
  }
  return best;
}

// Resolves { file, compressed, originalSize, width, height } — `file` is the File to upload.
// compressed is false only for non-images / SVGs (returned untouched). Throws if the image
// can't be decoded or encoded, so callers never silently upload an oversized original.
export async function compressImageToWebp(file, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!isCompressibleImage(file)) return { file, compressed: false, originalSize: file?.size };

  const source = await decode(file);
  const srcW = source.width, srcH = source.height;
  if (!srcW || !srcH) throw new Error('Could not read this image');

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let opaque = false;
  const draw = (scale) => {
    canvas.width = Math.max(1, Math.round(srcW * scale));
    canvas.height = Math.max(1, Math.round(srcH * scale));
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (opaque) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }  // JPEG has no transparency
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return Math.max(canvas.width, canvas.height);
  };

  // WebP where the browser can encode it (canvas.toBlob silently returns PNG otherwise).
  draw(Math.min(1, 64 / Math.max(srcW, srcH)));
  const probe = await encode(canvas, 'image/webp', 0.8);
  const type = probe?.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
  opaque = type === 'image/jpeg';

  const longest = Math.max(srcW, srcH);
  const quality = opts.quality[type];
  let scale = Math.min(1, opts.maxDimension / longest);
  let result = null;
  // 1. The normal case: one encode at the standard quality.
  draw(scale);
  const standard = await encode(canvas, type, quality);
  if (standard && standard.size <= opts.targetBytes) result = standard;
  // 2. Too detailed for 100 KB at that quality: step down until it fits.
  while (!result) {
    const side = draw(scale);
    const lo = side <= opts.minDimension ? opts.hardMinQuality : opts.minQuality;
    result = await bestQualityThatFits(canvas, type, opts.targetBytes, Math.min(lo, quality), quality);
    if (result) break;
    if (side <= opts.floorDimension) {
      // Tiny already and still too big (rare: extreme noise) — lower quality until it fits.
      for (let q = 0.35; q >= 0.05 && !result; q -= 0.05) {
        const blob = await encode(canvas, type, q);
        if (blob && blob.size <= opts.targetBytes) result = blob;
      }
      if (!result) throw new Error('Could not get this image under 100 KB');
      break;
    }
    const next = scale * 0.85;
    scale = Math.max(next, opts.floorDimension / longest);
  }
  source.close?.();
  if (!result) throw new Error('Could not compress this image');

  const ext = type === 'image/webp' ? 'webp' : 'jpg';
  const name = file.name.replace(/\.[^.]+$/, '') + '.' + ext;
  return {
    file: new File([result], name, { type, lastModified: Date.now() }),
    compressed: true,
    originalSize: file.size,
    width: canvas.width,
    height: canvas.height
  };
}

// The one entry point every image upload uses. Resolves { file, note } with the file to
// upload (as small as possible, never over 100 KB) and a short "2.1 MB → 48 KB WebP" note, or
// { error } when an image couldn't be compressed — the upload must then be refused, never
// sent as the original. Non-image files (PDFs) pass through untouched.
export async function prepareImageForUpload(file) {
  if (!isCompressibleImage(file)) return { file, note: '' };
  try {
    const out = await compressImageToWebp(file);
    const kb = n => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
    const label = out.file.type === 'image/webp' ? 'WebP' : 'JPEG';
    return { file: out.file, note: ` · ${kb(out.originalSize)} → ${kb(out.file.size)} ${label}` };
  } catch (e) {
    console.warn('Image compression failed', e);
    return { error: `Couldn't compress "${file.name}" to 100 KB (${e.message || 'unreadable image'}). Try saving it as a JPG or PNG and upload again.` };
  }
}
