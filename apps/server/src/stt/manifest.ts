export type SttPlatform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64"

export interface SttArchive {
  readonly url: string
  readonly sha256: string
  readonly bytes: number
}

export interface SttModel {
  readonly label: string
  readonly archive: SttArchive
  readonly modelType: string
  readonly encoder: string
  readonly decoder: string
  readonly joiner: string
  readonly tokens: string
  readonly sampleWav: string
  readonly sampleExpectedWord: string
}

export interface SttManifest {
  readonly runtimes: Partial<Record<SttPlatform, SttArchive>>
  readonly model: SttModel
}

const SHERPA_ONNX_VERSION = "1.13.8"
const SHERPA_ONNX_RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"

const sherpaOnnxRuntime = (platformSuffix: string, sha256: string, bytes: number): SttArchive => ({
  url: `${SHERPA_ONNX_RELEASES}/v${SHERPA_ONNX_VERSION}/sherpa-onnx-v${SHERPA_ONNX_VERSION}-${platformSuffix}.tar.bz2`,
  sha256,
  bytes,
})

export const PARAKEET_MANIFEST: SttManifest = {
  runtimes: {
    "darwin-arm64": sherpaOnnxRuntime("osx-arm64-shared-lib", "ae77050cdae565496059d96f5ab33d77b397a0864282a4e4a26e3b3b3effb948", 8_773_198),
    "darwin-x64": sherpaOnnxRuntime("osx-x64-shared-lib", "0f88371565a06372889c76266e253abd1b415fcc6f98232cabd968933efb0711", 10_014_197),
    "linux-x64": sherpaOnnxRuntime("linux-x64-shared-lib", "3892d184be41027e18165e67f549cd4e4cdd8dcd73ac5579e97afd55e14e30b6", 9_816_899),
    "linux-arm64": sherpaOnnxRuntime("linux-aarch64-shared-cpu-lib", "fb98b80628a383909bf83626daca2e0d0ffc93bf1f7d222eaaa4282b388f072f", 12_595_068),
  },
  model: {
    label: "Parakeet TDT 0.6B v3",
    archive: {
      url: `${SHERPA_ONNX_RELEASES}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
      sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
      bytes: 487_170_055,
    },
    modelType: "nemo_transducer",
    encoder: "encoder.int8.onnx",
    decoder: "decoder.int8.onnx",
    joiner: "joiner.int8.onnx",
    tokens: "tokens.txt",
    sampleWav: "test_wavs/en.wav",
    sampleExpectedWord: "country",
  },
}

export const sttPlatformOf = (os: string, cpu: string): SttPlatform | undefined => {
  if (os === "darwin" && cpu === "arm64") return "darwin-arm64"
  if (os === "darwin" && cpu === "x64") return "darwin-x64"
  if (os === "linux" && cpu === "x64") return "linux-x64"
  if (os === "linux" && cpu === "arm64") return "linux-arm64"
  return undefined
}
