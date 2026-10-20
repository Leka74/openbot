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
    "darwin-arm64": sherpaOnnxRuntime("osx-arm64-shared", "b10e5c7e2c30ea03de9c442655d14860d9edc475c6251d58a8f5f06e913a1d56", 20_314_448),
    "darwin-x64": sherpaOnnxRuntime("osx-x64-shared", "54aad64acee9d2d596535a6080d6f22602a720af5460e1d50461b1e1b06bee40", 22_846_038),
    "linux-x64": sherpaOnnxRuntime("linux-x64-shared", "c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4", 28_156_791),
    "linux-arm64": sherpaOnnxRuntime("linux-aarch64-shared-cpu", "4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789", 28_091_778),
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
