// ntfy (D3.6): the owner's notifications on any phone with the ntfy app (Android, iPhone, desktop).
// A topic on ntfy.sh, or on the owner's own ntfy server, turns each OpenBot notification into a push.
import { Schema } from "effect"
import { Millis } from "./base.ts"

/** Which notifications go to ntfy: all of them, or only a Bot waiting for the owner or failing. */
export const NtfySends = Schema.Literals(["all", "needs-you"])
export type NtfySends = typeof NtfySends.Type

export const NtfyStatus = Schema.Struct({
  connected: Schema.Boolean,
  sends: NtfySends,
  /** The ntfy server it publishes to. */
  server: Schema.optionalKey(Schema.String),
  /** The topic the owner's phone subscribes to. */
  topic: Schema.optionalKey(Schema.String),
  /** Why the last push failed (cleared by the next one that works). */
  problem: Schema.optionalKey(Schema.String),
  lastSentAt: Schema.optionalKey(Millis),
})
export type NtfyStatus = typeof NtfyStatus.Type

export const NTFY_DISCONNECTED: NtfyStatus = { connected: false, sends: "all" }

export const NTFY_URL = "https://ntfy.sh"
