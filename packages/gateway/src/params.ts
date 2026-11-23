/**
 * A tiny parameter DSL that yields BOTH the MCP `inputSchema` (JSON Schema) and a server-side
 * validator from one definition.
 *
 * Schema rules (mcp-conformance.md R5): object root with `properties` + `required`, primitives,
 * string `enum`, arrays with ONE `items` schema and `minItems`. No tuples, no `prefixItems`, no
 * `additionalItems`; nothing relies on `maxItems`/`minimum`/`pattern` being enforced by a harness —
 * every constraint is validated here and refused with a model-readable message that lists the valid
 * values.
 */

export type JsonSchema = { readonly [key: string]: unknown }

export type Decoded<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string }

const ok = <A>(value: A): Decoded<A> => ({ ok: true, value })
const fail = (error: string): Decoded<never> => ({ ok: false, error })

export interface Param<A, Opt extends boolean = false> {
  readonly json: JsonSchema
  readonly optional: Opt
  /** Decodes a present (non-undefined) value. `path` names the argument in messages. */
  readonly decode: (value: unknown, path: string) => Decoded<A>
  /** Used when the argument is absent (only for optional params with a default). */
  readonly fallback?: A | undefined
}

export type AnyParam = Param<any, boolean>

const withDescription = (json: JsonSchema, description: string | undefined): JsonSchema =>
  description === undefined ? json : { ...json, description }

export const string = (
  description?: string,
  options?: { readonly minLength?: number; readonly maxLength?: number },
): Param<string> => ({
  json: withDescription({ type: "string" }, description),
  optional: false,
  decode: (value, path) => {
    if (typeof value !== "string") return fail(`\`${path}\` must be a string`)
    if (options?.minLength !== undefined && value.length < options.minLength) {
      return fail(
        options.minLength === 1
          ? `\`${path}\` must not be empty`
          : `\`${path}\` must have at least ${options.minLength} characters`,
      )
    }
    if (options?.maxLength !== undefined && value.length > options.maxLength) {
      return fail(`\`${path}\` must have at most ${options.maxLength} characters`)
    }
    return ok(value)
  },
})

/** A non-empty string. */
export const text = (description?: string): Param<string> => string(description, { minLength: 1 })

export const number = (
  description?: string,
  options?: { readonly integer?: boolean; readonly min?: number; readonly max?: number },
): Param<number> => ({
  json: withDescription({ type: options?.integer === true ? "integer" : "number" }, description),
  optional: false,
  decode: (value, path) => {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value
    if (typeof n !== "number" || !Number.isFinite(n)) return fail(`\`${path}\` must be a number`)
    if (options?.integer === true && !Number.isInteger(n)) return fail(`\`${path}\` must be a whole number`)
    if (options?.min !== undefined && n < options.min) return fail(`\`${path}\` must be at least ${options.min}`)
    if (options?.max !== undefined && n > options.max) return fail(`\`${path}\` must be at most ${options.max}`)
    return ok(n)
  },
})

export const boolean = (description?: string): Param<boolean> => ({
  json: withDescription({ type: "boolean" }, description),
  optional: false,
  decode: (value, path) => {
    if (typeof value === "boolean") return ok(value)
    if (value === "true") return ok(true)
    if (value === "false") return ok(false)
    return fail(`\`${path}\` must be true or false`)
  },
})

/** A string enum (R5: string `enum` is in the safe subset). */
export const literals = <const L extends ReadonlyArray<string>>(values: L, description?: string): Param<L[number]> => ({
  json: withDescription({ type: "string", enum: [...values] }, description),
  optional: false,
  decode: (value, path) =>
    typeof value === "string" && (values as ReadonlyArray<string>).includes(value)
      ? ok(value as L[number])
      : fail(`\`${path}\` must be one of: ${values.join(", ")}`),
})

/** An array with a single `items` schema (never a tuple). `minItems` is emitted; `maxItems` is checked here only. */
export const array = <A>(
  item: Param<A, boolean>,
  description?: string,
  options?: { readonly minItems?: number; readonly maxItems?: number },
): Param<ReadonlyArray<A>> => ({
  json: withDescription(
    {
      type: "array",
      items: item.json,
      ...(options?.minItems === undefined ? {} : { minItems: options.minItems }),
    },
    description,
  ),
  optional: false,
  decode: (value, path) => {
    if (!Array.isArray(value)) return fail(`\`${path}\` must be an array`)
    if (options?.minItems !== undefined && value.length < options.minItems) {
      return fail(`\`${path}\` must have at least ${options.minItems} item${options.minItems === 1 ? "" : "s"}`)
    }
    if (options?.maxItems !== undefined && value.length > options.maxItems) {
      return fail(`\`${path}\` must have at most ${options.maxItems} items`)
    }
    const out: Array<A> = []
    for (let i = 0; i < value.length; i++) {
      const decoded = item.decode(value[i], `${path}[${i}]`)
      if (!decoded.ok) return decoded
      out.push(decoded.value)
    }
    return ok(out)
  },
})

export type Fields = { readonly [key: string]: AnyParam }

type OptionalKeys<F extends Fields> = { [K in keyof F]: F[K] extends Param<any, true> ? K : never }[keyof F]
type RequiredKeys<F extends Fields> = Exclude<keyof F, OptionalKeys<F>>
type ValueOf<P> = P extends Param<infer A, any> ? A : never

/** Decoded arguments: required keys are present; optional keys may be absent (or filled from a default). */
export type Infer<F extends Fields> = { readonly [K in RequiredKeys<F>]: ValueOf<F[K]> } & {
  readonly [K in OptionalKeys<F>]?: ValueOf<F[K]> | undefined
}

const objectJson = (fields: Fields, description?: string): JsonSchema => {
  const properties: Record<string, JsonSchema> = {}
  const required: Array<string> = []
  for (const [key, param] of Object.entries(fields)) {
    properties[key] = param.json
    if (!param.optional) required.push(key)
  }
  return withDescription({ type: "object", properties, ...(required.length > 0 ? { required } : {}) }, description)
}

const decodeObject = <F extends Fields>(fields: F, value: unknown, path: string | undefined): Decoded<Infer<F>> => {
  const input = value === undefined || value === null ? {} : value
  if (typeof input !== "object" || Array.isArray(input)) {
    return fail(path === undefined ? "Arguments must be an object" : `\`${path}\` must be an object`)
  }
  const record = input as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, param] of Object.entries(fields)) {
    const name = path === undefined ? key : `${path}.${key}`
    const raw = record[key]
    if (raw === undefined || raw === null) {
      if (!param.optional) return fail(`\`${name}\` is required`)
      if (param.fallback !== undefined) out[key] = param.fallback
      continue
    }
    const decoded = param.decode(raw, name)
    if (!decoded.ok) return decoded
    out[key] = decoded.value
  }
  // Unknown keys are ignored (models sometimes add extra fields).
  return ok(out as Infer<F>)
}

/** A nested object (e.g. one question of `ask_user`). */
export const object = <F extends Fields>(fields: F, description?: string): Param<Infer<F>> => ({
  json: objectJson(fields, description),
  optional: false,
  decode: (value, path) => decodeObject(fields, value, path),
})

/**
 * Any JSON object, passed on as it is (no `properties` in the schema): for a tool that checks it
 * itself against a fuller definition, e.g. `update_ui` against `show_ui`'s.
 */
export const anyObject = (description?: string): Param<Readonly<Record<string, unknown>>> => ({
  json: withDescription({ type: "object" }, description),
  optional: false,
  decode: (value, path) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? ok(value as Readonly<Record<string, unknown>>)
      : fail(`\`${path}\` must be an object`),
})

/** Marks a parameter optional; with `fallback`, an absent value decodes to it. */
export const optional = <A>(param: Param<A, boolean>, fallback?: A): Param<A, true> => ({
  json: fallback === undefined || typeof fallback === "object" ? param.json : { ...param.json, default: fallback },
  optional: true,
  decode: param.decode,
  fallback,
})

export interface ParamsSpec<A> {
  /** The MCP `inputSchema` (object root). */
  readonly inputSchema: {
    readonly type: "object"
    readonly properties: Record<string, JsonSchema>
    readonly required?: ReadonlyArray<string>
  }
  readonly decode: (args: unknown) => Decoded<A>
}

/** The tool's argument object. */
export const params = <F extends Fields>(fields: F): ParamsSpec<Infer<F>> => {
  const json = objectJson(fields) as ParamsSpec<Infer<F>>["inputSchema"]
  return {
    inputSchema: json.properties === undefined ? { ...json, properties: {} } : json,
    decode: (args) => decodeObject(fields, args, undefined),
  }
}

/** Recursively checks a JSON schema for constructs harnesses mangle (R5). Used by tests. */
export const findUnsafeSchemaKeywords = (schema: unknown, path = "$"): ReadonlyArray<string> => {
  if (typeof schema !== "object" || schema === null) return []
  const problems: Array<string> = []
  const record = schema as Record<string, unknown>
  for (const banned of ["prefixItems", "additionalItems", "$ref", "oneOf", "allOf", "anyOf", "not"]) {
    if (banned in record) problems.push(`${path}.${banned}`)
  }
  if (Array.isArray(record.items)) problems.push(`${path}.items (tuple)`)
  if (record.items === false) problems.push(`${path}.items (false)`)
  if (typeof record.items === "object" && record.items !== null && !Array.isArray(record.items)) {
    problems.push(...findUnsafeSchemaKeywords(record.items, `${path}.items`))
  }
  if (typeof record.properties === "object" && record.properties !== null) {
    for (const [key, value] of Object.entries(record.properties as Record<string, unknown>)) {
      problems.push(...findUnsafeSchemaKeywords(value, `${path}.${key}`))
    }
  }
  return problems
}
