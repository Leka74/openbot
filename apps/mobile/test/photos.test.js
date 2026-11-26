import { expect, test } from "bun:test"
import { imageBox, isHeic, jpegName, resizeFor, shouldCompress, SMALL_IMAGE_BYTES } from "../src/chat/photos.ts"

const MB = 1024 * 1024

test("an image's box is always explicit: its shape at 220 wide, square when unknown, cropped when very tall", () => {
  expect(imageBox(600, 400)).toEqual({ width: 220, height: 147 })
  expect(imageBox(undefined, undefined)).toEqual({ width: 220, height: 220 })
  expect(imageBox(0, 400)).toEqual({ width: 220, height: 220 })
  expect(imageBox(1206, 2622)).toEqual({ width: 220, height: 320 })
  expect(imageBox(4000, 200)).toEqual({ width: 220, height: 60 })
})

test("heavy, oversized and HEIC photos are compressed", () => {
  expect(shouldCompress({ name: "IMG_1.jpg", mime: "image/jpeg", size: 12 * MB, width: 8064, height: 6048 })).toBe(true)
  expect(shouldCompress({ name: "IMG_2.jpg", mime: "image/jpeg", size: 1 * MB, width: 4032, height: 3024 })).toBe(true)
  expect(shouldCompress({ name: "IMG_3.jpg", mime: "image/jpeg", size: 2 * MB, width: 2000, height: 1500 })).toBe(true)
  expect(shouldCompress({ name: "IMG_4.HEIC", mime: "image/heic", size: 0.4 * MB, width: 1000, height: 800 })).toBe(
    true,
  )
  expect(shouldCompress({ name: "IMG_5.heic", mime: "application/octet-stream", size: 0.4 * MB })).toBe(true)
  expect(shouldCompress({ name: "shot.png", mime: "image/png", size: 4 * MB, width: 1206, height: 2622 })).toBe(true)
})

test("small images, light screenshots, GIFs, videos and other files are left alone", () => {
  expect(shouldCompress({ name: "a.jpg", mime: "image/jpeg", size: 0.3 * MB, width: 1600, height: 1200 })).toBe(false)
  expect(
    shouldCompress({ name: "a.jpg", mime: "image/jpeg", size: SMALL_IMAGE_BYTES, width: 2560, height: 1920 }),
  ).toBe(false)
  expect(shouldCompress({ name: "shot.png", mime: "image/png", size: 0.9 * MB, width: 1206, height: 2622 })).toBe(false)
  expect(shouldCompress({ name: "a.jpg", mime: "image/jpeg", size: 0.3 * MB })).toBe(false)
  expect(shouldCompress({ name: "fun.gif", mime: "image/gif", size: 8 * MB, width: 4000, height: 4000 })).toBe(false)
  expect(shouldCompress({ name: "logo.svg", mime: "image/svg+xml", size: 2 * MB })).toBe(false)
  expect(shouldCompress({ name: "clip.mov", mime: "video/quicktime", size: 9 * MB, width: 3840, height: 2160 })).toBe(
    false,
  )
  expect(shouldCompress({ name: "report.pdf", mime: "application/pdf", size: 9 * MB })).toBe(false)
})

test("the long side comes down to 2560, whichever side it is", () => {
  expect(resizeFor(8064, 6048)).toEqual({ width: 2560 })
  expect(resizeFor(3024, 4032)).toEqual({ height: 2560 })
  expect(resizeFor(2560, 1920)).toBeUndefined()
  expect(resizeFor(800, 600)).toBeUndefined()
})

test("a compressed photo is named .jpg", () => {
  expect(jpegName("IMG_0042.HEIC")).toBe("IMG_0042.jpg")
  expect(jpegName("holiday.photo.png")).toBe("holiday.photo.jpg")
  expect(jpegName("scan")).toBe("scan.jpg")
  expect(jpegName(".heic")).toBe("photo.jpg")
  expect(isHeic({ name: "x.HEIF", mime: "" })).toBe(true)
  expect(isHeic({ name: "x.jpg", mime: "image/jpeg" })).toBe(false)
})
