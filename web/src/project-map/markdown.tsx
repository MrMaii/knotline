import type { ReactNode } from "react";

// Minimal Markdown rendering for agent replies: headings, lists, fenced code,
// bold, and inline code. Anything unrecognized falls back to plain text.
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("**")) nodes.push(<strong key={`${keyPrefix}-${key++}`}>{token.slice(2, -2)}</strong>);
    else nodes.push(<code key={`${keyPrefix}-${key++}`}>{token.slice(1, -1)}</code>);
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;
  let key = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join("\n");
    blocks.push(<p key={`p-${key++}`}>{inline(text, `p-${key}`)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, index) => <li key={`li-${index}`}>{inline(item, `li-${key}-${index}`)}</li>);
    blocks.push(list.ordered ? <ol key={`l-${key++}`}>{items}</ol> : <ul key={`l-${key++}`}>{items}</ul>);
    list = null;
  };

  for (const line of lines) {
    if (code !== null) {
      if (line.trimEnd() === "```") {
        blocks.push(<pre key={`c-${key++}`}><code>{code.join("\n")}</code></pre>);
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const content = inline(heading[2], `h-${key}`);
      blocks.push(level <= 2 ? <h4 key={`h-${key++}`}>{content}</h4> : <h5 key={`h-${key++}`}>{content}</h5>);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet?.[1] !== undefined || numbered?.[1] !== undefined) {
      flushParagraph();
      const ordered = numbered !== null;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((bullet?.[1] ?? numbered?.[1]) as string);
      continue;
    }
    if (trimmed === "") {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  if (code !== null) blocks.push(<pre key={`c-${key++}`}><code>{code.join("\n")}</code></pre>);
  flushParagraph();
  flushList();
  return blocks;
}
