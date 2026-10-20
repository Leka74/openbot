import { Mic, Square, X } from "lucide-react"
import type { ReactNode } from "react"
import { IconButton, Spinner } from "@openbot/ui"
import { type DictationControls, formatElapsed } from "./useDictation.ts"

export function DictationButton({ dictation, size }: { readonly dictation: DictationControls; readonly size: 28 | 36 }): ReactNode {
  if (dictation.phase === "finishing" || dictation.phase === "starting") {
    const label = dictation.phase === "starting" ? "Starting the microphone" : "Finishing the transcript"
    return (
      <span className="inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} data-testid="dictation-busy">
        <Spinner size={14} label={label} />
      </span>
    )
  }
  if (dictation.phase === "recording") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1" data-testid="dictation-recording">
        <IconButton icon={X} label="Cancel dictation" size={size} variant="ghost" onClick={dictation.cancel} />
        <span className="inline-flex items-center gap-1.5 text-sm tabular-nums text-fg-secondary">
          <span className="size-2 animate-pulse rounded-full bg-danger" aria-hidden />
          {formatElapsed(dictation.elapsedSeconds)}
        </span>
        <IconButton icon={Square} label="Stop dictation" title="Stop and transcribe" size={size} variant="primary" iconSize="xs" onClick={() => void dictation.finish()} className="[&_svg]:fill-current" />
      </span>
    )
  }
  return <IconButton icon={Mic} label="Dictate" title="Dictate a message" size={size} variant="ghost" onClick={dictation.start} />
}
