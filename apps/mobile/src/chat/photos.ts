// Photos in the chat, as plain rules: the size an attached image is drawn at, and which picked
// photos the phone shrinks before upload (compress.ts does the work). No React Native in here.

const IMAGE_WIDTH = 220
const IMAGE_MAX_HEIGHT = 320
const IMAGE_MIN_HEIGHT = 60

/**
 * The box of an image in a bubble: 220 wide, as tall as its shape asks (a very tall one is cropped
 * at 320); square while the dimensions are unknown. Always explicit numbers: `aspectRatio` gives a
 * child of a wrapping row no height at all.
 */
export const imageBox = (
  width: number | undefined,
  height: number | undefined,
): { readonly width: number; readonly height: number } => {
  if (!width || !height || width <= 0 || height <= 0) return { width: IMAGE_WIDTH, height: IMAGE_WIDTH }
  const natural = Math.round((IMAGE_WIDTH * height) / width)
  return { width: IMAGE_WIDTH, height: Math.min(IMAGE_MAX_HEIGHT, Math.max(IMAGE_MIN_HEIGHT, natural)) }
}

/** The long side a photo is scaled down to before upload. */
export const MAX_LONG_SIDE = 2560
export const JPEG_QUALITY = 0.8
/** At or under this, an image that is not too large in pixels goes up as it is. */
export const SMALL_IMAGE_BYTES = 1.5 * 1024 * 1024

export interface PhotoInfo {
  readonly name: string
  readonly mime: string
  /** bytes */
  readonly size: number
  readonly width?: number | undefined
  readonly height?: number | undefined
}

/** HEIC/HEIF: most of what reads the attachment later (browsers, Bots) cannot open it. */
export const isHeic = (p: Pick<PhotoInfo, "name" | "mime">): boolean =>
  /^image\/hei[cf]/i.test(p.mime) || /\.hei[cf]$/i.test(p.name)

/**
 * Whether a picked image is re-encoded as a JPEG (and scaled down to `MAX_LONG_SIDE`) before upload.
 * HEIC always; anything heavy; anything larger in pixels, except a light PNG (a screenshot stays
 * sharp). GIFs (animation) and SVGs are never touched.
 */
export const shouldCompress = (p: PhotoInfo): boolean => {
  if (!p.mime.startsWith("image/") && !isHeic(p)) return false
  if (/^image\/(gif|svg)/i.test(p.mime)) return false
  if (isHeic(p)) return true
  if (p.size > SMALL_IMAGE_BYTES) return true
  if (/^image\/png/i.test(p.mime)) return false
  return Math.max(p.width ?? 0, p.height ?? 0) > MAX_LONG_SIDE
}

/** The resize that brings the long side down to `MAX_LONG_SIDE` (the other side follows); none when it fits. */
export const resizeFor = (
  width: number,
  height: number,
): { readonly width: number } | { readonly height: number } | undefined =>
  Math.max(width, height) <= MAX_LONG_SIDE
    ? undefined
    : width >= height
      ? { width: MAX_LONG_SIDE }
      : { height: MAX_LONG_SIDE }

/** `IMG_0042.HEIC` → `IMG_0042.jpg`. */
export const jpegName = (name: string): string => {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, "")
  return `${base === "" ? "photo" : base}.jpg`
}
