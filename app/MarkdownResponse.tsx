import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Renders a response's markdown (headers, bold/italic, lists, tables,
// code blocks) as real formatting instead of raw source text -- used for
// both the live-streaming view and the history/reload view, so a
// response looks the same whichever way it's currently being read.
//
// Safe by design, not just by convention: react-markdown parses to an
// AST and never renders raw HTML unless rehype-raw is added (it isn't
// here) -- so literal HTML/script-looking text in a response (including
// anything an adversarial prompt might coax the model into producing)
// renders as inert text, never executes.
//
// Mid-stream, `content` is necessarily incomplete/malformed (an unclosed
// **, a table that hasn't finished) -- verified directly (not assumed)
// that react-markdown/remark-gfm never throws on this: unclosed spans
// fall back to their literal characters, an in-progress table/list still
// renders as much as has arrived, and it simply re-renders correctly
// once the stream completes. No error boundary needed for this reason.
export function MarkdownResponse({ content }: { content: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
}
