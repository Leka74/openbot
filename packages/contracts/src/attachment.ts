// A file in OpenBot (a message's attachment, a Slack draft's file). Its own module so card.ts and
// transcript.ts can both use it without importing each other.
import { Schema } from "effect"
import { AttachmentId, NonNegativeInt } from "./base.ts"

export const Attachment = Schema.Struct({
  id: AttachmentId,
  name: Schema.String,
  mime: Schema.String,
  byteSize: Schema.optionalKey(NonNegativeInt),
  /** Server URL (`/api/attachments/:id`); attachments are uploaded first. */
  url: Schema.String,
  width: Schema.optionalKey(NonNegativeInt),
  height: Schema.optionalKey(NonNegativeInt),
})
export type Attachment = typeof Attachment.Type
