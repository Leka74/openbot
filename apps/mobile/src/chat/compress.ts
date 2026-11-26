// Shrinks a picked photo on the phone before upload (the rules are in photos.ts): the long side
// down to 2560 px, saved as a JPEG, with the orientation baked into the pixels. A 12 to 48 MP photo
// then stays far below the upload limit. Whatever goes wrong, the original is sent instead.
import { File } from "expo-file-system"
import { ImageManipulator, SaveFormat } from "expo-image-manipulator"
import { isHeic, JPEG_QUALITY, jpegName, type PhotoInfo, resizeFor, shouldCompress } from "./photos.ts"

export interface Picked extends PhotoInfo {
  readonly key: string
  readonly uri: string
  readonly image: boolean
}

const sizeOf = (uri: string): number => {
  try {
    return new File(uri).size
  } catch {
    return 0
  }
}

export const compressPhoto = async (picked: Picked): Promise<Picked> => {
  if (!picked.image) return picked
  // pickers don't always say how heavy a file is
  const p = picked.size > 0 ? picked : { ...picked, size: sizeOf(picked.uri) }
  if (!shouldCompress(p)) return p
  try {
    const context = ImageManipulator.manipulate(p.uri)
    let image = await context.renderAsync()
    const resize = resizeFor(image.width, image.height)
    if (resize) image = await context.resize(resize).renderAsync()
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY })
    const size = sizeOf(saved.uri)
    // re-encoding alone made it no lighter: keep the original
    if (size === 0 || (!resize && !isHeic(p) && size >= p.size)) return p
    return {
      ...p,
      uri: saved.uri,
      name: jpegName(p.name),
      mime: "image/jpeg",
      size,
      width: saved.width,
      height: saved.height,
    }
  } catch {
    return p
  }
}
