// Mounts one <Markdown> whose text the test swaps with `window.setMarkdown`, so a re-render with a
// new image source can be watched in a real browser (md-image.test.ts).
import { type ReactNode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { Markdown } from "../src/chat/Markdown.tsx"

declare global {
  interface Window {
    setMarkdown: (text: string) => void
  }
}

function Harness(): ReactNode {
  const [text, setText] = useState(new URLSearchParams(location.search).get("md") ?? "")
  useEffect(() => {
    window.setMarkdown = setText
  }, [])
  return <Markdown text={text} />
}

createRoot(document.getElementById("root")!).render(<Harness />)
