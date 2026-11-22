"use strict"
// The owner's queue page (served by the brain at /queue/, shown in the app at #/queue). Driven from the keyboard:
// j/k move · Enter open · Esc back · e done · ⌘Enter approve · r reply · h remind · # trash · z undo
// x select · ⌘A select all · ⌘U not this kind · / search · Tab next split · g then i/s/f · ⌘K commands · ? shortcuts.
// The API is same-origin and rides on the owner's session cookie (queue/live.ts).
const $ = (id) => document.getElementById(id)
const mac = /Mac|iPhone|iPad/.test(navigator.platform)
let items = [],
  sel = 0,
  area = "",
  state = {},
  modalKey = null
let mode = "stacks",
  stackFilter = null,
  query = "",
  picked = new Set(),
  gPending = 0
const REASONS = [
  ["s", "stale"],
  ["m", "not mine"],
  ["b", "bot noise"],
  ["l", "low value"],
]

// ---- look like the app ------------------------------------------------------------------------------------------
// Inside OpenBot the page is a same-origin frame: follow the app's theme live and use its own fonts.
function appDoc() {
  try {
    return window.parent !== window ? window.parent.document : null
  } catch {
    return null
  }
}
function syncTheme() {
  const d = appDoc()
  document.documentElement.dataset.theme = (d && d.documentElement.dataset.theme) || "system"
}
function borrowFonts() {
  const d = appDoc()
  if (!d || !document.fonts) return
  const want = new Set(["Inter Variable", "Geist Mono Variable"])
  for (const sheet of d.styleSheets) {
    let rules
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const r of rules) {
      if (r.type !== 5) continue // CSSFontFaceRule
      const fam = r.style.getPropertyValue("font-family").replace(/["']/g, "").trim()
      if (!want.has(fam)) continue
      const base = sheet.href || d.location.href
      const src = r.style
        .getPropertyValue("src")
        .replace(/url\((["']?)([^"')]+)\1\)/g, (m, q, u) => `url("${new URL(u, base).href}")`)
      const desc = {}
      for (const [k, p] of [
        ["weight", "font-weight"],
        ["style", "font-style"],
        ["unicodeRange", "unicode-range"],
        ["display", "font-display"],
      ]) {
        const v = r.style.getPropertyValue(p)
        if (v) desc[k] = v
      }
      try {
        const f = new FontFace(fam, src, desc)
        document.fonts.add(f)
        f.load().catch(() => {})
      } catch {
        /* the system font stays */
      }
    }
  }
}
syncTheme()
borrowFonts()
;(() => {
  const d = appDoc()
  if (d)
    new MutationObserver(syncTheme).observe(d.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
})()
if (window.matchMedia) window.matchMedia("(max-width: 760px)").addEventListener("change", () => render())

// ---- data -------------------------------------------------------------------------------------------------------
async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || "failed")
  return data
}
function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
function kbd(k) {
  return el("kbd", null, k)
}
const CMD = mac ? "⌘" : "Ctrl+"
function toast(msg, bad, undoable) {
  const t = $("toast")
  t.replaceChildren(msg)
  t.className = bad ? "bad" : ""
  if (undoable) {
    const u = el("span")
    u.append("Undo ", kbd("Z"))
    t.append(u)
  }
  t.hidden = false
  clearTimeout(t._h)
  t._h = setTimeout(() => (t.hidden = true), undoable ? 6000 : 3500)
}
function current() {
  const r = items[sel]
  return r && !r.kind ? r : null
}
function currentStack() {
  const r = items[sel]
  return r && r.kind === "stack" ? r : null
}
function rowKey(r) {
  return r ? (r.kind ? "s:" + r.sig : r.id) : null
}
function matches(i) {
  if (!query) return true
  const q = query.toLowerCase()
  return [i.title, i.owner, i.why, i.area].some((x) => x && x.toLowerCase().includes(q))
}
function visible() {
  if (!state.items) return []
  const its = state.items.filter((i) => (!area || i.area === area) && matches(i))
  if (stackFilter) {
    const ids = new Set(stackFilter.ids)
    return its.filter((i) => ids.has(i.id))
  }
  if (mode !== "stacks" || query) return its
  const st = (state.stacks || []).filter((x) => !area || x.area === area)
  const inStack = new Set(st.flatMap((x) => x.ids))
  return [...st.map((x) => Object.assign({ kind: "stack" }, x)), ...its.filter((i) => !inStack.has(i.id))]
}
async function load(keep) {
  const keepId = keep ? rowKey(items[sel]) : null
  const res = await fetch("api/state")
  if (!res.ok) {
    toast("Couldn't load the queue", true)
    return
  }
  state = await res.json()
  if (stackFilter) {
    const st = (state.stacks || []).find((x) => x.sig === stackFilter.sig)
    stackFilter = st ? { sig: st.sig, ids: st.ids, label: st.label } : null
  }
  const open = new Set((state.items || []).map((i) => i.id))
  picked = new Set([...picked].filter((id) => open.has(id)))
  items = visible()
  if (keepId) {
    const i = items.findIndex((x) => rowKey(x) === keepId)
    if (i >= 0) sel = i
  }
  sel = Math.min(sel, Math.max(items.length - 1, 0))
  render()
}

// ---- render -----------------------------------------------------------------------------------------------------
function ago(ms) {
  const d = Math.floor((Date.now() - ms) / 86400000)
  if (d >= 1) return `${d}d`
  const h = Math.floor((Date.now() - ms) / 3600000)
  return h >= 1 ? `${h}h` : "now"
}
function splitsList() {
  return ["", ...new Set((state.items || []).map((i) => i.area))].sort()
}
function render() {
  const open = state.openTotal || 0,
    cleared = state.clearedToday || 0
  $("count").textContent = open ? `${open}` : ""
  const burn = $("burn")
  burn.replaceChildren()
  const bar = el("div", "bar"),
    fill = el("div", "fill")
  fill.style.width = `${cleared + open ? Math.round((100 * cleared) / (cleared + open)) : 100}%`
  bar.append(fill)
  burn.append(bar, el("span", null, `${cleared} cleared today`))
  const nav = $("splits")
  nav.replaceChildren()
  const v = el("button", "split view", mode === "stacks" ? "Stacks" : "One by one")
  v.title = "g s / g i"
  v.onclick = toggleMode
  nav.append(v, el("span", "split-sep"))
  const counts = {}
  ;(state.items || []).forEach((i) => (counts[i.area] = (counts[i.area] || 0) + 1))
  splitsList().forEach((a) => {
    const b = el("button", "split" + (a === area ? " on" : ""), a || "All")
    b.append(el("span", "c", a ? counts[a] : (state.items || []).length))
    b.onclick = () => setArea(a)
    nav.append(b)
  })
  const on = (state.rules || []).filter((r) => r.on)
  nav.append(el("span", "split-sep"))
  const f = el("button", "split", "Filtered")
  f.append(
    el(
      "span",
      "c",
      on.reduce((n, r) => n + r.filtered, 0),
    ),
  )
  f.title = "g f"
  f.onclick = showRules
  nav.append(f)
  const st = $("status")
  st.replaceChildren()
  if (picked.size) st.append(`${picked.size} selected · e done · h remind · Esc clear`)
  else if (state.pendingDelivery) st.append(`${state.pendingDelivery} going back to the Bots`)
  renderList()
  renderDetail()
  renderHints()
}
function renderList() {
  const list = $("list")
  list.replaceChildren()
  if (stackFilter) {
    const b = el("div", "sec back", `← ${stackFilter.label}`)
    b.title = "Esc"
    b.onclick = leaveStack
    list.append(b)
  }
  if (!items.length) {
    const e = el("div", "empty")
    e.append(
      el("b", null, query ? "No matches" : "Inbox zero"),
      query ? "Esc clears the search." : "Nothing is waiting on you.",
    )
    list.append(e)
    return
  }
  items.forEach((it, i) => {
    if (mode === "stacks" && !stackFilter && !query && (i === 0 || items[i - 1].kind !== it.kind))
      list.append(el("div", "sec", it.kind ? "Stacks · e clears one" : "One by one"))
    list.append(it.kind ? stackRow(it, i) : itemRow(it, i))
  })
}
function itemRow(it, i) {
  const r = el("div", "row" + (i === sel ? " sel" : "") + (picked.has(it.id) ? " picked" : ""))
  const hot = it.reasons.some((x) => /overdue|due today|due tomorrow|critical|blocking/.test(x))
  r.append(el("span", "dot" + (hot ? " hot" : "")), el("span", "who", it.owner || it.area))
  const w = el("span", "what")
  w.append(el("span", "tag " + it.type, it.type), it.title)
  if (it.why) w.append(el("span", "why", it.why))
  r.append(w)
  const due = it.reasons.find((x) => /overdue|due/.test(x))
  r.append(el("span", "when" + (due ? " due" : ""), due || ago(it.createdMs)))
  r.onclick = (e) => {
    sel = i
    if (e.metaKey || e.shiftKey) togglePick()
    else {
      openReading()
      render()
    }
  }
  if (i === sel) requestAnimationFrame(() => r.scrollIntoView({ block: "nearest" }))
  return r
}
function stackRow(st, i) {
  const r = el("div", "row stack" + (i === sel ? " sel" : ""))
  r.append(el("span", "dot"))
  const who = el("span", "who")
  who.append(el("span", "n-pill", st.count))
  r.append(who)
  const w = el("span", "what")
  w.append(el("span", "tag " + st.type, st.type), st.label)
  r.append(w)
  r.append(el("span", "when", ageRange(st)))
  r.onclick = () => {
    sel = i
    openReading()
    render()
  }
  if (i === sel) requestAnimationFrame(() => r.scrollIntoView({ block: "nearest" }))
  return r
}
function ageRange(st) {
  return st.newestDays === st.oldestDays ? `${st.oldestDays}d` : `${st.newestDays}–${st.oldestDays}d`
}
function btn(label, key, fn, primary) {
  const b = el("button", "btn" + (primary ? " primary" : ""), label)
  b.append(kbd(key))
  b.onclick = fn
  return b
}
function block(label, child) {
  const b = el("div", "block")
  b.append(el("div", "label", label), child)
  return b
}
function renderStack(d, st) {
  d.append(el("h1", null, `${st.count} × ${st.label}`), el("div", "meta", `${st.area} · ${ageRange(st)} old`))
  const a = el("div", "actions")
  a.append(
    btn("Clear stack", "E", () => clearStack(st), true),
    btn("Go one by one", "↵", () => enterStack(st)),
    btn("Not this kind", `${CMD}U`, () => notKind(st)),
  )
  d.append(a)
  d.append(
    block(
      "Clearing does",
      el(
        "div",
        null,
        "Marks all of them done: they close, nothing is sent and no Bot is told. Any that materially change come back. Z brings the whole stack back for 60 minutes.",
      ),
    ),
  )
  const l = el("div")
  st.sample.forEach((x) => l.append(el("div", "ev", x.title)))
  if (st.count > st.sample.length) l.append(el("div", "hint", `and ${st.count - st.sample.length} more`))
  d.append(block("In this stack", l))
}
function renderDetail() {
  const d = $("detail")
  d.replaceChildren()
  if (isPhone() && document.body.classList.contains("reading")) {
    const b = el("button", "ghost", "← Back")
    b.onclick = closeReading
    d.append(b)
  }
  const st = currentStack()
  if (st) return renderStack(d, st)
  const it = current()
  if (!it) {
    const e = el("div", "empty")
    e.append(el("b", null, "Inbox zero"), "Nothing is waiting on you.")
    d.append(e)
    return
  }
  const top = el("div")
  top.append(el("span", "tag " + it.type, it.type))
  d.append(top, el("h1", null, it.title))
  const rev = it.revision > 1 ? ` · revision ${it.revision}` : ""
  d.append(
    el(
      "div",
      "meta",
      [it.owner, it.area, it.due ? `due ${it.due}` : null, it.reasons.join(", ")].filter(Boolean).join(" · ") + rev,
    ),
  )
  const a = el("div", "actions")
  if (it.type !== "fyi") a.append(btn("Approve", `${CMD}↵`, () => approve(), true))
  a.append(
    btn("Done", "E", () => done()),
    btn("Reply", "R", () => askNote("reply")),
    btn("Remind me", "H", () => remind()),
    btn("Trash", "#", () => trash()),
    btn("Not this kind", `${CMD}U`, () => notKind(it)),
  )
  d.append(a)
  if (it.why) d.append(block("Why now", el("div", null, it.why)))
  if (it.recommendation) d.append(block("Recommendation", el("div", "rec", it.recommendation)))
  const does = approveMeans(it)
  if (does) d.append(block(`${CMD}↵ will`, el("div", null, does)))
  if (it.options.length) {
    const o = el("div")
    it.options.forEach((x, i) => {
      const isRec = x.id === it.recOption
      const r = el("div", "opt" + (isRec ? " pick" : ""))
      r.append(kbd(i + 1), x.label + (isRec ? "  (recommended)" : ""))
      r.onclick = () => pickOption(i + 1)
      o.append(r)
    })
    d.append(block("Options", o))
  }
  if (it.evidence.length) {
    const e = el("div")
    it.evidence.forEach((x) => {
      const r = el("div", "ev")
      if (x.url && /^https:\/\//.test(x.url)) {
        const l = el("a", null, x.text)
        l.href = x.url
        l.target = "_blank"
        l.rel = "noopener noreferrer"
        r.append(l)
      } else r.textContent = x.text
      e.append(r)
    })
    d.append(block("Evidence", e))
  }
}
function approveMeans(it) {
  if (it.type === "fyi") return null
  const pick = it.options.find((x) => x.id === it.recOption)
  const route = `Tell ${it.owner || "the Bot"}`
  if (it.options.length && !pick) return "Nothing yet: there's no recommended option, so pick one with its number."
  return pick ? `${route} you chose: ${pick.label}.` : `${route} to go ahead.`
}
const KEYMAP = [
  ["Move", "J / K"],
  ["Open", "↵"],
  ["Back", "Esc"],
  ["Done", "E"],
  ["Approve", `${CMD}↵`],
  ["Reply (change)", "R"],
  ["Remind me", "H"],
  ["Trash", "#"],
  ["Undo", "Z"],
  ["Select", "X"],
  ["Select all", `${CMD}A`],
  ["Not this kind", `${CMD}U`],
  ["Pick option", "1–9"],
  ["Open link", "O"],
  ["Search", "/"],
  ["Next split", "Tab"],
  ["Stacks / one by one", "G S / G I"],
  ["Filtered", "G F"],
  ["Commands", `${CMD}K`],
  ["Shortcuts", "?"],
]
function renderHints() {
  const f = $("hints")
  f.replaceChildren()
  ;[
    ["E", "done"],
    [`${CMD}↵`, "approve"],
    ["H", "remind"],
    ["#", "trash"],
    ["Z", "undo"],
    [`${CMD}K`, "commands"],
    ["?", "shortcuts"],
  ].forEach(([k, v]) => {
    const s = el("span")
    s.append(kbd(k), v)
    f.append(s)
  })
}

// ---- actions ----------------------------------------------------------------------------------------------------
const DONE_MSG = {
  approve: "Approved",
  reject: "Rejected",
  reply: "Sent back with your reply",
  snooze: "Reminder set",
  drop: "Trashed",
  skip: "Marked done",
}
async function act(action, extra, it) {
  it = it || current()
  if (!it) return
  try {
    await api("api/decide", Object.assign({ id: it.id, action }, extra || {}))
    toast(DONE_MSG[action], false, action !== "snooze")
    await load(false)
  } catch (e) {
    toast(e.message, true)
  }
}
function needItem() {
  if (currentStack()) {
    toast("This is a stack: E clears it, ↵ goes one by one", true)
    return null
  }
  return current()
}
async function done() {
  if (picked.size) {
    const ids = [...picked]
    try {
      const r = await api("api/decide", { action: "skip", ids })
      picked.clear()
      toast(`${r.decided} marked done`, false, true)
      await load(false)
    } catch (e) {
      toast(e.message, true)
    }
    return
  }
  const st = currentStack()
  if (st) return clearStack(st)
  if (needItem()) act("skip")
}
function trash() {
  if (picked.size) return toast("Trash tells each Bot, so it goes one at a time. E marks a selection done.", true)
  if (needItem()) act("drop")
}
function approve(option) {
  if (picked.size) return toast("Approve one at a time. E marks a selection done.", true)
  const it = needItem()
  if (!it) return
  if (it.type === "fyi") return toast("Nothing to approve: E marks it done", true)
  if (it.options.length && option === undefined) {
    if (!it.recOption) return toast("Pick an option with its number, or R to say something else", true)
    option = it.recOption
  }
  act("approve", option === undefined ? {} : { option })
}
function pickOption(n) {
  const it = current()
  if (it && it.options[n - 1]) approve(it.options[n - 1].id)
}
function closeModal() {
  $("modal").hidden = true
  $("modal").replaceChildren()
  modalKey = null
}
function openModal(box, onKey) {
  const m = $("modal")
  m.replaceChildren(box)
  m.hidden = false
  modalKey = onKey
  m.onclick = (e) => {
    if (e.target === m) closeModal()
  }
}
function askNote(action, prefill) {
  if (picked.size) return toast("Reply goes to one item at a time", true)
  const it = needItem()
  if (!it) return
  const b = el("div", "box")
  b.append(el("h2", null, action === "reply" ? `Reply to ${it.owner || "the Bot"}: what should change?` : "Why not?"))
  const t = el("textarea")
  t.value = prefill || ""
  b.append(t)
  const h = el("div", "hint")
  h.append(kbd(`${CMD}↵`), " or ", kbd("↵"), " sends it back · ", kbd("Esc"), " cancels")
  b.append(h)
  openModal(b, null)
  t.focus()
  t.addEventListener("keydown", (e) => {
    e.stopPropagation()
    if (e.key === "Escape") closeModal()
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      const note = t.value.trim()
      if (!note) return toast(action === "reply" ? "Say what should change" : "Say why not", true)
      closeModal()
      act(action, { note }, it)
    }
  })
}
function remind() {
  const targets = picked.size ? (state.items || []).filter((i) => picked.has(i.id)) : [needItem()].filter(Boolean)
  if (!targets.length) return
  const now = new Date(),
    at = (d) => Math.max(0.25, (d - now) / 3600000)
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  tomorrow.setHours(8, 0, 0, 0)
  const monday = new Date(now)
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7))
  monday.setHours(8, 0, 0, 0)
  const choices = [
    ["Later today", 3],
    ["Tomorrow, 08:00", at(tomorrow)],
    ["Next week, Monday 08:00", at(monday)],
    ["In a month", 24 * 30],
  ]
  const b = el("div", "box")
  b.append(el("h2", null, targets.length > 1 ? `Remind me about ${targets.length} items` : "Remind me"))
  choices.forEach(([label], i) => {
    const r = el("div", "opt")
    r.append(kbd(i + 1), label)
    r.onclick = () => go(i)
    b.append(r)
  })
  b.append(el("div", "hint", "It leaves the queue and comes back at that time."))
  async function go(i) {
    closeModal()
    try {
      await api("api/decide", { ids: targets.map((it) => it.id), action: "snooze", hours: choices[i][1] })
      picked.clear()
      toast(`Back ${choices[i][0].toLowerCase()}`)
      await load(false)
    } catch (e) {
      toast(e.message, true)
    }
  }
  openModal(b, (e) => {
    e.preventDefault()
    if (/^[1-4]$/.test(e.key)) go(Number(e.key) - 1)
    else if (e.key === "Escape" || e.key === "h") closeModal()
  })
}
async function undo() {
  try {
    const r = await api("api/undo")
    if (r.item) {
      toast(r.count > 1 ? `Undone: ${r.count} back` : "Undone")
      await load(false)
      const i = items.findIndex((x) => x.id === r.item)
      if (i >= 0) {
        sel = i
        render()
      }
    } else toast("Nothing to undo: it has already gone back to the Bot", true)
  } catch (e) {
    toast(e.message, true)
  }
}
function togglePick() {
  const it = current()
  if (!it) return
  if (picked.has(it.id)) picked.delete(it.id)
  else picked.add(it.id)
  render()
}
function pickAll() {
  const its = items.filter((x) => !x.kind)
  const all = its.every((x) => picked.has(x.id))
  its.forEach((x) => (all ? picked.delete(x.id) : picked.add(x.id)))
  render()
}
function move(d) {
  sel = Math.max(0, Math.min(items.length - 1, sel + d))
  render()
}
function setArea(a) {
  area = a
  stackFilter = null
  sel = 0
  items = visible()
  render()
}
function nextSplit(d) {
  const s = splitsList()
  setArea(s[(s.indexOf(area) + d + s.length) % s.length])
}
function setMode(m) {
  mode = m
  stackFilter = null
  sel = 0
  items = visible()
  render()
}
function toggleMode() {
  setMode(mode === "stacks" ? "list" : "stacks")
}
function enterStack(st) {
  stackFilter = { sig: st.sig, ids: st.ids, label: st.label }
  sel = 0
  items = visible()
  render()
}
function leaveStack() {
  stackFilter = null
  sel = 0
  items = visible()
  render()
}
function isPhone() {
  return window.matchMedia && window.matchMedia("(max-width: 760px)").matches
}
function openReading() {
  if (isPhone()) document.body.classList.add("reading")
}
function closeReading() {
  document.body.classList.remove("reading")
  render()
}
function openLink() {
  const it = current()
  const u = it && it.evidence.find((x) => x.url && /^https:\/\//.test(x.url))
  if (u) window.open(u.url, "_blank", "noopener,noreferrer")
  else toast("No link on this item", true)
}
function openSearch() {
  $("searchbar").hidden = false
  $("search").focus()
  $("search").select()
}
function closeSearch() {
  query = ""
  $("search").value = ""
  $("searchbar").hidden = true
  sel = 0
  items = visible()
  render()
}
$("search").addEventListener("input", () => {
  query = $("search").value.trim()
  sel = 0
  items = visible()
  render()
})
$("search").addEventListener("keydown", (e) => {
  e.stopPropagation()
  if (e.key === "Escape") {
    e.preventDefault()
    closeSearch()
  } else if (e.key === "Enter" || e.key === "ArrowDown") {
    e.preventDefault()
    $("search").blur()
  }
})

// ---- burn-down: stacks and "not this kind" rules ----------------------------------------------------------------
function clearStack(st) {
  const b = el("div", "box")
  b.append(el("h2", null, `Clear ${st.count} items?`), el("div", null, st.label))
  const h = el("div", "hint")
  h.append(
    kbd("E"),
    " or ",
    kbd("↵"),
    " marks them all done: nothing sent, no Bot told. ",
    kbd("Z"),
    " undoes the whole stack for 60 minutes.",
  )
  b.append(h)
  openModal(b, async (e) => {
    e.preventDefault()
    closeModal()
    if (e.key !== "Enter" && e.key !== "e") return
    try {
      const r = await api("api/stack-clear", { sig: st.sig, ids: st.ids })
      toast(`Cleared ${r.cleared}`, false, true)
      await load(false)
    } catch (err) {
      toast(err.message, true)
      await load(false)
    }
  })
}
async function notKind(target) {
  if (!target) return
  let sugg
  try {
    sugg = (await api("api/rule-suggest", target.kind ? { sig: target.sig } : { id: target.id })).suggestions
  } catch (e) {
    return toast(e.message, true)
  }
  const reasons = new Set()
  let pick = 0,
    phrase = null
  const b = el("div", "box")
  b.append(
    el("h2", null, "Don't bring me this kind"),
    el(
      "div",
      "hint",
      "Pick how wide. Filtered items are kept, never deleted: G F shows them and turns a rule off. High-stakes, due-soon and blocking items always get through.",
    ),
  )
  const opts = el("div")
  b.append(opts)
  const inp = el("input", "field")
  inp.placeholder = "or: anything with this phrase in the title"
  const phraseRow = el("div", "opt")
  const phraseInfo = el("span", "hint")
  phraseRow.append(kbd(sugg.length + 1), inp)
  b.append(phraseRow, phraseInfo)
  const chips = el("div", "chips")
  REASONS.forEach(([k, label]) => {
    const c = el("button", "chip", label)
    c.title = k.toUpperCase()
    c.onclick = () => toggleReason(label)
    chips.append(c)
  })
  b.append(el("div", "label", "Why (optional)"), chips)
  const h = el("div", "hint")
  h.append(kbd("1–9"), " choose · letters pick a reason · ", kbd("↵"), " saves · ", kbd("Esc"), " cancels")
  b.append(h)
  function draw() {
    opts.replaceChildren()
    sugg.forEach((x, i) => {
      const r = el("div", "opt" + (i === pick ? " pick" : ""))
      r.append(
        kbd(i + 1),
        el("span", null, x.label),
        el("span", "hint", `catches ${x.count} now${x.protected ? `, ${x.protected} protected stay` : ""}`),
      )
      r.onclick = () => {
        pick = i
        draw()
      }
      opts.append(r)
    })
    phraseRow.className = "opt" + (pick === sugg.length ? " pick" : "")
    ;[...chips.children].forEach((c) => c.classList.toggle("on", reasons.has(c.textContent)))
  }
  function toggleReason(label) {
    if (reasons.has(label)) reasons.delete(label)
    else reasons.add(label)
    draw()
  }
  let t = null
  inp.addEventListener("focus", () => {
    pick = sugg.length
    draw()
  })
  inp.addEventListener("input", () => {
    clearTimeout(t)
    phrase = null
    phraseInfo.textContent = ""
    t = setTimeout(async () => {
      const v = inp.value.trim()
      if (v.length < 3) return
      try {
        phrase = await api("api/rule-preview", { match: { titleHas: v } })
        phraseInfo.textContent = `catches ${phrase.count} now. It matches titles containing exactly this text.`
      } catch (e) {
        phraseInfo.textContent = e.message
      }
    }, 250)
  })
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation()
    if (e.key === "Escape") closeModal()
    if (e.key === "Enter") {
      e.preventDefault()
      save()
    }
  })
  async function save() {
    let chosen = pick < sugg.length ? sugg[pick] : phrase
    if (pick === sugg.length) {
      // Enter can beat the typing preview: check the phrase as it stands now
      const v = inp.value.trim()
      if (v.length < 3) {
        phraseInfo.textContent = "Type at least 3 letters"
        return inp.focus()
      }
      clearTimeout(t)
      try {
        chosen = phrase = await api("api/rule-preview", { match: { titleHas: v } })
      } catch (e) {
        phraseInfo.textContent = e.message
        return inp.focus()
      }
    }
    if (!chosen) return toast("Type a phrase of 3+ letters, or pick 1–" + sugg.length, true)
    closeModal()
    try {
      const r = await api("api/rule-add", { match: chosen.match, reason: [...reasons].join(", ") })
      toast(`Rule saved: ${r.filtered} filtered · G F to see or turn it off`)
      await load(false)
    } catch (e) {
      toast(e.message, true)
    }
  }
  openModal(b, (e) => {
    if (e.key === "Escape") {
      e.preventDefault()
      return closeModal()
    }
    if (e.key === "Enter") {
      e.preventDefault()
      return save()
    }
    if (/^[1-9]$/.test(e.key)) {
      e.preventDefault()
      const n = Number(e.key) - 1
      if (n < sugg.length) {
        pick = n
        draw()
      } else if (n === sugg.length) inp.focus()
      return
    }
    const r = REASONS.find(([k]) => k === e.key)
    if (r) {
      e.preventDefault()
      toggleReason(r[1])
    }
  })
  draw()
}
function showRules() {
  const rules = state.rules || []
  const b = el("div", "box")
  b.append(el("h2", null, "Filtered: what you asked not to see"))
  if (!rules.length) {
    const h = el("div", "hint")
    h.append("No rules yet. Press ", kbd(`${CMD}U`), " on an item or a stack to add one.")
    b.append(h)
  }
  const on = rules.filter((r) => r.on)
  rules.forEach((r) => {
    const row = el("div", "opt" + (r.on ? "" : " off"))
    const n = on.indexOf(r)
    row.append(
      kbd(r.on && n < 9 ? n + 1 : "·"),
      el("span", null, r.label),
      el("span", "hint", r.on ? `${r.filtered} filtered${r.reason ? ` · ${r.reason}` : ""}` : "off"),
    )
    if (r.on) {
      const x = el("button", "btn", "Turn off, bring back")
      x.onclick = () => ruleOff(r)
      row.append(x)
    }
    b.append(row)
  })
  b.append(el("div", "hint", "A number turns that rule off and brings its items back. Esc closes."))
  openModal(b, (e) => {
    e.preventDefault()
    if (/^[1-9]$/.test(e.key) && on[Number(e.key) - 1]) ruleOff(on[Number(e.key) - 1])
    else if (e.key === "Escape") closeModal()
  })
}
async function ruleOff(r) {
  closeModal()
  try {
    const x = await api("api/rule-off", { id: r.id })
    toast(`Rule off: ${x.restored} back in the queue`)
    await load(false)
  } catch (e) {
    toast(e.message, true)
  }
}
function showShortcuts() {
  const b = el("div", "box")
  b.append(el("h2", null, "Shortcuts"))
  const g = el("div", "keymap")
  KEYMAP.forEach(([what, k]) => {
    const r = el("div")
    r.append(what, kbd(k))
    g.append(r)
  })
  b.append(g)
  openModal(b, (e) => {
    e.preventDefault()
    closeModal()
  })
}

// ---- command palette (⌘K) ---------------------------------------------------------------------------------------
function commands() {
  const st = currentStack(),
    it = current()
  const c = []
  if (st)
    c.push(
      ["Clear stack", "E", () => clearStack(st)],
      ["Go through stack one by one", "↵", () => enterStack(st)],
      ["Not this kind", `${CMD}U`, () => notKind(st)],
    )
  if (it)
    c.push(
      ["Approve", `${CMD}↵`, () => approve()],
      ["Done (skip, tell nobody)", "E", done],
      ["Reply with changes", "R", () => askNote("reply")],
      ["Reject", "", () => askNote("reject")],
      ["Remind me", "H", remind],
      ["Trash (tell the Bot it's dropped)", "#", trash],
      ["Not this kind", `${CMD}U`, () => notKind(it)],
      ["Open link", "O", openLink],
      ["Select", "X", togglePick],
    )
  if (picked.size)
    c.push(
      [`Mark ${picked.size} selected done`, "E", done],
      [`Remind me about ${picked.size} selected`, "H", remind],
      [
        "Clear selection",
        "Esc",
        () => {
          picked.clear()
          render()
        },
      ],
    )
  c.push(
    ["Undo", "Z", undo],
    ["Search", "/", openSearch],
    [mode === "stacks" ? "Go to one by one" : "Go to stacks", mode === "stacks" ? "G I" : "G S", toggleMode],
    ["Go to filtered rules", "G F", showRules],
    ["Select all", `${CMD}A`, pickAll],
    ["Reload", "", () => load(true)],
    ["Keyboard shortcuts", "?", showShortcuts],
  )
  splitsList().forEach((a) => c.push([`Split: ${a || "All"}`, "", () => setArea(a)]))
  return c
}
function palette() {
  const all = commands()
  let shown = all,
    on = 0
  const b = el("div", "box palette")
  const inp = el("input")
  inp.placeholder = "Type a command"
  const list = el("div", "cmds")
  b.append(inp, list)
  function draw() {
    const q = inp.value.trim().toLowerCase()
    shown = all.filter(([l]) => !q || q.split(/\s+/).every((w) => l.toLowerCase().includes(w)))
    on = Math.min(on, Math.max(shown.length - 1, 0))
    list.replaceChildren()
    shown.forEach(([label, keys, fn], i) => {
      const r = el("div", "cmd" + (i === on ? " on" : ""))
      r.append(el("span", null, label))
      const k = el("span", "keys")
      if (keys) keys.split(" ").forEach((x) => k.append(kbd(x)))
      r.append(k)
      r.onclick = () => {
        closeModal()
        fn()
      }
      r.onmouseenter = () => {
        on = i
        ;[...list.children].forEach((c, j) => c.classList.toggle("on", j === on))
      }
      list.append(r)
    })
  }
  inp.addEventListener("input", () => {
    on = 0
    draw()
  })
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation()
    if (e.key === "Escape" || (e.key === "k" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault()
      closeModal()
    } else if (e.key === "ArrowDown" || (e.key === "j" && e.ctrlKey)) {
      e.preventDefault()
      on = Math.min(on + 1, shown.length - 1)
      draw()
    } else if (e.key === "ArrowUp" || (e.key === "k" && e.ctrlKey)) {
      e.preventDefault()
      on = Math.max(on - 1, 0)
      draw()
    } else if (e.key === "Enter") {
      e.preventDefault()
      const c = shown[on]
      closeModal()
      if (c) c[2]()
    }
  })
  openModal(b, null)
  draw()
  inp.focus()
}
$("cmdk").onclick = palette
$("cmdk-key").textContent = `${CMD}K`

// ---- keys -------------------------------------------------------------------------------------------------------
document.addEventListener("keydown", (e) => {
  if (modalKey) return modalKey(e)
  if (!$("modal").hidden) {
    if (e.key === "Escape") closeModal()
    return
  }
  const mod = e.metaKey || e.ctrlKey
  if (mod) {
    const k = e.key.toLowerCase()
    const map = {
      k: palette,
      enter: () => approve(),
      u: () => notKind(currentStack() || current()),
      a: pickAll,
      z: undo,
      backspace: trash,
    }
    if (map[k] && !e.altKey) {
      e.preventDefault()
      map[k]()
    }
    return
  }
  if (e.altKey) return
  if (e.repeat && !/^(j|k|ArrowDown|ArrowUp)$/.test(e.key)) return // a held key must not decide the next item too
  if (gPending && Date.now() - gPending < 1500) {
    gPending = 0
    const g = { i: () => setMode("list"), s: () => setMode("stacks"), f: showRules }[e.key]
    if (g) {
      e.preventDefault()
      g()
    }
    return
  }
  gPending = 0
  const map = {
    j: () => move(1),
    ArrowDown: () => move(1),
    k: () => move(-1),
    ArrowUp: () => move(-1),
    Enter: () => {
      const st = currentStack()
      if (st) enterStack(st)
      else openReading()
      render()
    },
    Escape: () => {
      if (picked.size) {
        picked.clear()
        render()
      } else if (document.body.classList.contains("reading")) closeReading()
      else if (query) closeSearch()
      else if (stackFilter) leaveStack()
    },
    e: done,
    r: () => askNote("reply"),
    h: remind,
    "#": trash,
    z: undo,
    x: togglePick,
    o: openLink,
    "/": openSearch,
    "?": showShortcuts,
    Tab: () => nextSplit(e.shiftKey ? -1 : 1),
    g: () => {
      gPending = Date.now()
    },
    n: () => notKind(currentStack() || current()),
  }
  if (map[e.key]) {
    e.preventDefault()
    map[e.key]()
    return
  }
  if (/^[1-9]$/.test(e.key)) pickOption(Number(e.key))
})
load(false)
setInterval(() => {
  if ($("modal").hidden && document.activeElement !== $("search")) load(true)
}, 20000)
window.addEventListener("focus", () => {
  if (window.parent !== window) syncTheme()
})
