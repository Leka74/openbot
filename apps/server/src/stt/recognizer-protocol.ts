export interface RecognizerLaunch {
  readonly library: string
  readonly encoder: string
  readonly decoder: string
  readonly joiner: string
  readonly tokens: string
  readonly modelType: string
  readonly threads: number
  readonly sampleRate: number
}

export interface RecognizerRequest {
  readonly id: number
  readonly samples: Float32Array
  readonly sampleRate: number
}

export type RecognizerReply =
  | { readonly type: "ready" }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "decoded"; readonly id: number; readonly text: string }
  | { readonly type: "decode-failed"; readonly id: number; readonly message: string }
