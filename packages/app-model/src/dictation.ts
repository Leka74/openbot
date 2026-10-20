export const downsample = (samples: Float32Array, fromRate: number, toRate: number): Float32Array => {
  if (fromRate === toRate) return samples
  const ratio = fromRate / toRate
  const output = new Float32Array(Math.floor(samples.length / ratio))
  for (let index = 0; index < output.length; index++) {
    const start = Math.floor(index * ratio)
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let source = start; source < end; source++) sum += samples[source]!
    output[index] = end > start ? sum / (end - start) : 0
  }
  return output
}

const PCM16_BYTES = 2

export const encodePcm16 = (samples: Float32Array): Uint8Array => {
  const view = new DataView(new ArrayBuffer(samples.length * PCM16_BYTES))
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(index * PCM16_BYTES, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  })
  return new Uint8Array(view.buffer)
}

export const joinChunks = (chunks: ReadonlyArray<Float32Array>): Float32Array => {
  const joined = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return joined
}

export const toBase64 = (bytes: Uint8Array): string => {
  const CHUNK = 0x8000
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += CHUNK) binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  return btoa(binary)
}

export const insertDictation = (draft: string, caret: number, spoken: string): { readonly text: string; readonly caret: number } => {
  if (spoken.length === 0) return { text: draft, caret }
  const before = draft.slice(0, caret)
  const after = draft.slice(caret)
  const leading = before.length > 0 && !/\s$/.test(before) ? " " : ""
  const trailing = after.length > 0 && !/^\s/.test(after) ? " " : ""
  const inserted = `${leading}${spoken}${trailing}`
  return { text: before + inserted + after, caret: before.length + inserted.length }
}
