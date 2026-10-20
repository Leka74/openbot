import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { RecognizerLaunch, RecognizerReply, RecognizerRequest } from "../../src/stt/recognizer-protocol.ts"

const HANG_ABOVE = 0.6
const CRASH_ABOVE = 0.85

const launch = JSON.parse(process.argv[2] ?? "{}") as RecognizerLaunch
const misheardFile = path.join(path.dirname(launch.tokens), "misheard.txt")
const heard = existsSync(misheardFile) ? readFileSync(misheardFile, "utf8").trim() : "country"
const reply = (message: RecognizerReply) => process.send?.(message)

process.on("message", (request: RecognizerRequest) => {
  const peak = request.samples.reduce((loudest, sample) => Math.max(loudest, Math.abs(sample)), 0)
  if (peak > CRASH_ABOVE) process.exit(7)
  if (peak > HANG_ABOVE) return
  reply({ type: "decoded", id: request.id, text: heard })
})
process.on("disconnect", () => process.exit(0))
reply({ type: "ready" })
