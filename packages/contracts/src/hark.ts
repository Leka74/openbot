// Hark (D3.5): the owner's iPhone notifications through hark.ryan.ceo until the OpenBot iPhone app
// has its own. A Hark "service" webhook (`/hooks/whk_…`) turns each OpenBot notification into a push.
import { Schema } from "effect"
import { Millis } from "./base.ts"

/** Which notifications go to Hark: all of them, or only a Bot waiting for the owner or failing. */
export const HarkSends = Schema.Literals(["all", "needs-you"])
export type HarkSends = typeof HarkSends.Type

export const HarkStatus = Schema.Struct({
  connected: Schema.Boolean,
  sends: HarkSends,
  /** Why the last push failed (cleared by the next one that works). */
  problem: Schema.optionalKey(Schema.String),
  lastSentAt: Schema.optionalKey(Millis),
})
export type HarkStatus = typeof HarkStatus.Type

export const HARK_DISCONNECTED: HarkStatus = { connected: false, sends: "all" }

export const HARK_URL = "https://hark.ryan.ceo"
