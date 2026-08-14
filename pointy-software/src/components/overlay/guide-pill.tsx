import { useEffect, useRef, type HTMLAttributes } from "react";
import { Crosshair } from "lucide-react";
import { motion } from "motion/react";

import { AnswerMarkdown } from "@/components/overlay/answer-markdown";
import type { ClickTarget } from "@/lib/pointy";

export type GuidePhase = "listening" | "processing" | "composing" | "answered";

const SPRING = { type: "spring", stiffness: 380, damping: 30 } as const;

const GLASS = {
  background: "rgba(17, 19, 22, 0.94)",
  boxShadow: [
    "inset 0 1px 0 rgba(255, 255, 255, 0.08)",
    "inset 0 0 0 1px rgba(255, 255, 255, 0.06)",
    "0 18px 48px -16px rgba(0, 0, 0, 0.62)",
  ].join(", "),
} as const;

/**
 * Guide-Dot that morphs into the answer card.
 *
 * Listening / processing stay a compact orb (pulse, then a spinner). On an answer —
 * or when speech is empty and they need to type — the same dark glass expands.
 */
export function GuidePill({
  phase,
  query,
  onQueryChange,
  onSubmit,
  answer,
  error,
  target,
  indicating,
  onIndicate,
  headerProps,
}: {
  phase: GuidePhase;
  query: string;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  answer: string;
  error: string | null;
  target: ClickTarget | null;
  indicating: boolean;
  onIndicate: () => void;
  headerProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const compact = phase === "listening" || phase === "processing";
  const processing = phase === "processing";

  useEffect(() => {
    if (phase === "composing") inputRef.current?.focus();
  }, [phase]);

  const caption =
    phase === "listening"
      ? query || "Listening…"
        : phase === "processing"
          ? "Keep working — Pointy is reading the screen"
        : phase === "composing"
          ? "Type your question — then Enter"
          : indicating
            ? "Click the highlighted control — Esc to stop pointing"
            : "Esc to close · Indicate to show where";

  return (
    <div className="flex flex-col items-center gap-4">
      <motion.div
        layout
        initial={{ opacity: 0, scale: 0.88 }}
        animate={{
          opacity: 1,
          scale: 1,
          width: compact ? 76 : 448,
          borderRadius: compact ? 999 : 28,
        }}
        exit={{ opacity: 0, scale: 0.94, y: 8 }}
        transition={SPRING}
        className="relative overflow-hidden"
        style={GLASS}
        onClick={(event) => event.stopPropagation()}
      >
        {compact ? (
          <div className="relative flex size-[76px] items-center justify-center">
            {processing && (
              <motion.span
                className="absolute inset-[-3px] rounded-full"
                style={{
                  background: "conic-gradient(from 0deg, transparent 40%, #ffa61f 100%)",
                  mask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
                  WebkitMask:
                    "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
                }}
                animate={{ rotate: 360 }}
                transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}
              />
            )}
            <motion.span
              className="size-2.5 rounded-full"
              style={{
                background: "linear-gradient(to top, #d9a865, #ffa61f)",
                boxShadow: "0 0 12px rgba(255,166,31,0.55)",
              }}
              animate={
                processing
                  ? { scale: 1, opacity: 0.85 }
                  : { scale: [0.85, 1.25, 0.85], opacity: [0.45, 1, 0.45] }
              }
              transition={
                processing
                  ? { duration: 0.2 }
                  : { duration: 1.15, repeat: Infinity, ease: "easeInOut" }
              }
            />
          </div>
        ) : (
          <div className="flex w-[448px] flex-col">
            <div
              className="flex cursor-grab items-center gap-2 px-4 pt-3.5 pb-2 active:cursor-grabbing"
              {...headerProps}
            >
              <span
                className="size-2 rounded-full"
                style={{ background: "linear-gradient(to top, #d9a865, #ffa61f)" }}
              />
              <span className="text-[0.75rem] font-semibold tracking-[-0.01em] text-white/70">
                Pointy
              </span>
            </div>

            {phase === "composing" && (
              <form
                className="px-3 pb-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (query.trim()) onSubmit();
                }}
              >
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(event) => onQueryChange(event.target.value)}
                  placeholder="Ask about this screen…"
                  className="w-full rounded-2xl bg-white/6 px-3.5 py-2.5 text-[0.9375rem] text-white/95 outline-none placeholder:text-white/35"
                  style={{ boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.07)" }}
                  autoComplete="off"
                  spellCheck={false}
                />
                {error && (
                  <p className="mt-2 px-1 text-xs leading-relaxed text-[#f0a094]">{error}</p>
                )}
              </form>
            )}

            {phase === "answered" && (
              <div className="select-text px-4 pb-4">
                {query && (
                  <p className="mb-2 text-[0.6875rem] text-white/40">{query}</p>
                )}
                {error ? (
                  <p className="text-sm leading-relaxed text-[#f0a094]">{error}</p>
                ) : (
                  <AnswerMarkdown text={answer} />
                )}
                {target && (
                  <button
                    type="button"
                    onClick={onIndicate}
                    className="mt-3 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[0.8125rem] font-semibold tracking-[-0.01em] transition-opacity hover:opacity-90"
                    style={{
                      background: indicating
                        ? "rgba(255,166,31,0.18)"
                        : "linear-gradient(to top, #d9a865, #ffa61f)",
                      color: indicating ? "#ffa61f" : "#2e3a47",
                      boxShadow: indicating ? "inset 0 0 0 1px rgba(255,166,31,0.45)" : undefined,
                    }}
                  >
                    <Crosshair className="size-3.5" />
                    {indicating ? "Hide highlight" : "Indicate"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </motion.div>

      <motion.p
        key={caption}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-[22rem] text-center text-[0.8125rem] font-medium tracking-[-0.01em]"
        style={{ color: "rgba(244, 246, 248, 0.72)" }}
      >
        {caption}
      </motion.p>
    </div>
  );
}
