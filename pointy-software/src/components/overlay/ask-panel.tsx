import { useEffect, useRef, type HTMLAttributes } from "react";
import { GripHorizontal, Loader2, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { PointyMark } from "@/components/pointy-mark";
import { VoiceVisualizer } from "@/components/overlay/voice-visualizer";

export type AskPhase = "listening" | "composing" | "asking" | "answered";

const SPRING = { type: "spring", stiffness: 380, damping: 30 } as const;

const PANEL = {
  background: "rgba(17, 19, 22, 0.94)",
  border: "1px solid rgba(255, 255, 255, 0.08)",
  shadow: [
    "inset 0 1px 0 rgba(255, 255, 255, 0.07)",
    "0 24px 64px -20px rgba(0, 0, 0, 0.72)",
  ].join(", "),
} as const;

/**
 * Rectangular glass ask window — live voice in the search bar, then the answer.
 */
export function AskPanel({
  phase,
  query,
  onQueryChange,
  onSubmit,
  answer,
  advice,
  error,
  bands,
  level,
  headerProps,
}: {
  phase: AskPhase;
  query: string;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  answer: string;
  advice: string;
  error: string | null;
  bands: number[];
  level: number;
  headerProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listening = phase === "listening";
  const asking = phase === "asking";
  const answered = phase === "answered";
  const composing = phase === "composing";

  useEffect(() => {
    if (composing || answered) inputRef.current?.focus();
  }, [composing, answered]);

  const hint = listening
    ? "Keep holding — your words appear here"
    : asking
      ? "Looking at your screen…"
      : answered
        ? "Esc to close · drag the top bar to move · hold to ask again"
        : "Type a question and press Enter";

  return (
    <motion.div
      initial={{ opacity: 0, y: 18, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.98 }}
      transition={SPRING}
      className="flex w-[min(34rem,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-[1.35rem]"
      style={PANEL}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="flex cursor-grab items-center justify-between px-4 pt-3.5 pb-2 active:cursor-grabbing"
        {...headerProps}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <GripHorizontal className="size-4 text-white/30" />
          <PointyMark className="size-5 [&_circle[stroke]]:stroke-white/55" />
          <span className="text-[0.8125rem] font-semibold tracking-[-0.01em] text-white/90">
            Pointy
          </span>
        </div>
        <motion.span
          className="size-2 rounded-full"
          style={{ background: "linear-gradient(to top, #d9a865, #ffa61f)" }}
          animate={
            listening
              ? { scale: [0.85, 1.25, 0.85], opacity: [0.5, 1, 0.5] }
              : { scale: 1, opacity: asking ? 0.7 : 1 }
          }
          transition={
            listening
              ? { duration: 1.1, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.2 }
          }
        />
      </div>

      <form
        className="px-3 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!asking && query.trim()) onSubmit();
        }}
      >
        <label
          className="flex items-center gap-3 rounded-2xl px-3.5 py-2.5"
          style={{
            background: "rgba(255, 255, 255, 0.06)",
            boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.07)",
          }}
        >
          {asking ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-[#ffa61f]" />
          ) : (
            <Search className="size-4 shrink-0 text-white/45" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            readOnly={listening || asking}
            placeholder={listening ? "Listening…" : "Ask about this screen…"}
            className="min-w-0 flex-1 bg-transparent text-[0.9375rem] text-white/95 outline-none placeholder:text-white/35"
            autoComplete="off"
            spellCheck={false}
          />
          {listening && (
            <div className="shrink-0">
              <VoiceVisualizer bands={bands} level={level} />
            </div>
          )}
        </label>
      </form>

      <AnimatePresence initial={false}>
        {(answered || asking || error) && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING}
            className="overflow-hidden"
          >
            <div className="border-t border-white/8 px-4 pt-3 pb-4">
              {error ? (
                <p className="text-sm leading-relaxed text-[#f0a094]">{error}</p>
              ) : asking ? (
                <p className="text-sm text-white/50">Reading the screen and your question…</p>
              ) : (
                <>
                  <p className="text-[0.625rem] font-semibold tracking-[0.14em] text-white/40 uppercase">
                    Pointy
                  </p>
                  <div className="mt-1.5 text-[0.9375rem] leading-relaxed text-white/90">
                    <AnswerBody text={answer} />
                  </div>
                  {advice && (
                    <p className="mt-3 text-xs leading-relaxed text-white/45">{advice}</p>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <p className="px-4 pb-3 text-center text-[0.6875rem] text-white/32">{hint}</p>
    </motion.div>
  );
}

/** Light markdown: paragraphs and **bold** UI labels. */
function AnswerBody({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).filter(Boolean);
  return (
    <div className="space-y-2">
      {blocks.map((block, i) => (
        <p key={i}>
          {block.split(/(\*\*[^*]+\*\*)/g).map((chunk, j) =>
            chunk.startsWith("**") && chunk.endsWith("**") ? (
              <strong key={j} className="font-semibold text-white">
                {chunk.slice(2, -2)}
              </strong>
            ) : (
              <span key={j}>{chunk}</span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}
