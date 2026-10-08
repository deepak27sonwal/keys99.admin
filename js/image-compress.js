// Converts an uploaded photo to WebP at (or just under) a target size — 100 KB by default —
// in the browser, before it's sent to Storage. Quality is kept as high as the budget allows:
// it binary-searches the encoder quality first, and only shrinks the pixel dimensions when even
// a modest quality can't fit, so a photo is never degraded more than the size cap requires.
//
// Skipped (the original file is returned untouched): non-images, GIFs (would lose animation),
// SVGs, and browsers whose canvas can't encode WebP (canvas.toBlob silently falls back to PNG
// there — detected by checking the returned blob's type).

const DEFAULTS = {
  targetBytes: 100 * 1024,
  maxDimension: 2400,   // longest side for the first attempt — larger than any listing display
  minDimension: 1000,   // never shrink below this to hit the target; accept a bigger file instead
  minQuality: 0.6,      // quality floor before resorting to smaller dimensions
  hardMinQuality: 0.4   // absolute floor, only used once dimensions reach minDimension
};

export function isCompressibleImage(file) {
  return !!file && /^image\//.test(file.type) && !/^image\/(gif|svg\+xml)$/.test(file.type);
}

function encode(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
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
async function bestQualityThatFits(canvas, targetBytes, lo, hi) {
  const atLo = await encode(canvas, lo);
  if (!atLo || atLo.type !== 'image/webp') return { unsupported: true };
  if (atLo.size > targetBytes) return null;
  let best = atLo;
  const atHi = await encode(canvas, hi);
  if (atHi.size <= targetBytes) return atHi;
  for (let i = 0; i < 6; i++) {           // ~1.5% quality resolution over [0.6, 0.95]
    const mid = (lo + hi) / 2;
    const blob = await encode(canvas, mid);
    if (blob.size <= targetBytes) { best = blob; lo = mid; } else { hi = mid; }
  }
  return best;
}

// Resolves { file, compressed, originalSize } — `file` is the WebP File to upload (or the
// original when skipped / unsupported).
export async function compressImageToWebp(file, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const original = { file, compressed: false, originalSize: file?.size };
  if (!isCompressibleImage(file)) return original;

  let source;
  try { source = await decode(file); } catch { return original; }
  const srcW = source.width, srcH = source.height;
  if (!srcW || !srcH) return original;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let scale = Math.min(1, opts.maxDimension / Math.max(srcW, srcH));
  let result = null;

  for (;;) {
    canvas.width = Math.max(1, Math.round(srcW * scale));
    canvas.height = Math.max(1, Math.round(srcH * scale));
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

    const atMinDim = Math.max(canvas.width, canvas.height) <= opts.minDimension;
    const fit = await bestQualityThatFits(canvas, opts.targetBytes, atMinDim ? opts.hardMinQuality : opts.minQuality, 0.95);
    if (fit?.unsupported) return original;
    if (fit) { result = fit; break; }
    if (atMinDim) {
      // Can't reach the target without visibly wrecking the image — keep the best this size allows.
      result = await encode(canvas, opts.hardMinQuality);
      break;
    }
    scale = Math.max(scale * 0.85, opts.minDimension / Math.max(srcW, srcH));
  }
  source.close?.();

  const name = file.name.replace(/\.[^.]+$/, '') + '.webp';
  return {
    file: new File([result], name, { type: 'image/webp', lastModified: Date.now() }),
    compressed: true,
    originalSize: file.size,
    width: canvas.width,
    height: canvas.height
  };
}
