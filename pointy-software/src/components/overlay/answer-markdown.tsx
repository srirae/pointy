/** Lightweight markdown for a single NIM answer — not a chat transcript. */

export function AnswerMarkdown({
  text,
  tone = "dark",
}: {
  text: string;
  tone?: "dark" | "light";
}) {
  const blocks = splitBlocks(text.replace(/^```(?:markdown)?\s*|\s*```$/g, "").trim());
  const light = tone === "light";

  return (
    <div
      className={
        light
          ? "space-y-2.5 text-[0.9375rem] leading-relaxed text-[#2e3a47]"
          : "space-y-2.5 text-[0.9375rem] leading-relaxed text-white/90"
      }
    >
      {blocks.map((block, i) => {
        if (block.type === "list") {
          return (
            <ul key={i} className="list-disc space-y-1 pl-4">
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} light={light} />
                </li>
              ))}
            </ul>
          );
        }
        if (block.type === "ordered") {
          return (
            <ol key={i} className="list-decimal space-y-1 pl-4">
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item} light={light} />
                </li>
              ))}
            </ol>
          );
        }
        return (
          <p key={i}>
            <Inline text={block.text} light={light} />
          </p>
        );
      })}
    </div>
  );
}

type Block =
  | { type: "p"; text: string }
  | { type: "list"; items: string[] }
  | { type: "ordered"; items: string[] };

function splitBlocks(raw: string): Block[] {
  const lines = raw.split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    const text = para.join(" ").trim();
    if (text) blocks.push({ type: "p", text });
    para = [];
  };
  const flushList = () => {
    if (!list?.items.length) {
      list = null;
      return;
    }
    blocks.push(
      list.ordered
        ? { type: "ordered", items: list.items }
        : { type: "list", items: list.items },
    );
    list = null;
  };

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)/);
    if (bullet) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1]!);
      continue;
    }
    if (numbered) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(numbered[1]!);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}

function Inline({ text, light = false }: { text: string; light?: boolean }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className={light ? "font-semibold text-[#0d4a47]" : "font-semibold text-white"}>
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code
              key={i}
              className={
                light
                  ? "rounded-md bg-[#0d4a47]/8 px-1 py-0.5 font-mono text-[0.8125rem] text-[#0d4a47]"
                  : "rounded-md bg-white/8 px-1 py-0.5 font-mono text-[0.8125rem] text-[#ffa61f]"
              }
            >
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
