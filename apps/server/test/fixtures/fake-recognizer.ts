import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { RecognizerLaunch, RecognizerReply, RecognizerRequest } from "../../src/stt/recognizer-protocol.ts"

const DECODE_FAILS_ABOVE = 0.45
const HANGS_ABOVE = 0.6
const CRASHES_ABOVE = 0.85

const launch = JSON.parse(process.argv[2]!) as RecognizerLaunch
const modelDir = path.dirname(launch.tokens)
const marker = (name: string) => path.join(modelDir, name)
const reply = (message: RecognizerReply) => process.send?.(message)

if (existsSync(marker("fail-start"))) {
  console.error("error: the fake model cannot be loaded")
  process.exit(1)
}
if (existsSync(marker("ignore-sigterm"))) process.on("SIGTERM", () => undefined)
const heard = existsSync(marker("misheard.txt")) ? readFileSync(marker("misheard.txt"), "utf8").trim() : "country"

process.on("message", (request: RecognizerRequest) => {
  const peak = request.samples.reduce((loudest, sample) => Math.max(loudest, Math.abs(sample)), 0)
  if (peak > CRASHES_ABOVE) process.exit(7)
  if (peak > HANGS_ABOVE) return
  if (peak > DECODE_FAILS_ABOVE) return reply({ type: "decode-failed", id: request.id, message: "the fake model could not decode" })
  reply({ type: "decoded", id: request.id, text: heard })
})
process.on("disconnect", () => process.exit(0))
reply({ type: "ready" })
