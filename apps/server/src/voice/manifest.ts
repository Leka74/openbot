/**
 * What voice calls download (experiment), pinned by size and SHA-256 like voice input's Parakeet:
 * Kokoro's voices. Speech in and the sherpa-onnx library come from voice input, which a call needs
 * anyway; the thinking and talking is the Bot's own.
 */
import type { SttArchive, SttPlatform } from "../stt/manifest.ts"

export interface VoiceManifest {
  readonly voices: {
    readonly label: string
    readonly archive: SttArchive
    /** Files in the unpacked folder. */
    readonly model: string
    readonly voices: string
    readonly tokens: string
    readonly dataDir: string
    readonly lexicon: string
    readonly lang: string
  }
}

export const VOICE_MANIFEST: VoiceManifest = {
  voices: {
    label: "Kokoro",
    archive: {
      url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
      sha256: "60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4",
      bytes: 349_886_476,
    },
    model: "model.onnx",
    voices: "voices.bin",
    tokens: "tokens.txt",
    dataDir: "espeak-ng-data",
    lexicon: "lexicon-us-en.txt",
    lang: "en-us",
  },
}

/** Voice calls run where voice input runs (Kokoro uses the same sherpa-onnx library). */
export const voiceDownloadBytes = (manifest: VoiceManifest, platform: SttPlatform | undefined): number | undefined =>
  platform === undefined ? undefined : manifest.voices.archive.bytes
