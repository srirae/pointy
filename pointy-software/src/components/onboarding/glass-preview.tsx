import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { HotkeyCombo } from "@/components/hotkey-combo";
import { PointyMark } from "@/components/pointy-mark";
import { cn } from "@/lib/utils";

type Phase = "idle" | "wake" | "ask" | "answer";

const PHASE_MS: Record<Phase, number> = {
  idle: 2200,
  wake: 1800,
  ask: 3200,
  answer: 3200,
};

/**
 * Auto-loop: hotkey wakes a glass panel — voice + text question, then answer.
 * Shows how Pointy occupies space without blocking the whole screen.
 */
export function GlassPreview({ className }: { className?: string }) {
  const [phase, setPhase] = useState<Phase>("idle");

  useEffect(() => {
    const order: Phase[] = ["idle", "wake", "ask", "answer"];
    let i = 0;
    const tick = () => {
      i = (i + 1) % order.length;
      setPhase(order[i]!);
    };
    const timer = window.setInterval(tick, PHASE_MS[phase]);
    return () => window.clearInterval(timer);
  }, [phase]);

  const glassOpen = phase !== "idle";

  return (
    <div
      className={cn(
        "pointer-events-none relative aspect-[16/10] w-full overflow-hidden rounded-2xl border border-border/50 shadow-[0_28px_60px_-32px_rgba(46,58,71,0.45)] select-none",
        className,
      )}
    >
      {/* App underneath — blurred when glass is open */}
      <div
        className={cn(
          "absolute inset-0 bg-gradient-to-br from-[#e8ecf0] via-[#dfe5ea] to-[#d4dce4] transition-all duration-700",
          glassOpen && "scale-[1.02] blur-[2px] brightness-95",
        )}
      >
        <div className="flex items-center gap-2 border-b border-black/5 bg-white/80 px-4 py-2">
          <span className="size-2 rounded-full bg-black/10" />
          <span className="size-2 rounded-full bg-black/10" />
          <span className="text-[0.625rem] font-medium text-muted-foreground">Your app</span>
        </div>
        <div className="space-y-3 p-6">
          <div className="h-3 w-2/3 rounded bg-black/8" />
          <div className="h-3 w-1/2 rounded bg-black/6" />
          <div className="h-3 w-3/4 rounded bg-black/6" />
          <div className="mt-8 h-24 rounded-lg border border-dashed border-black/10 bg-white/50" />
        </div>
      </div>

      {/* Glass panel */}
      <AnimatePresence>
        {glassOpen && (
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 340, damping: 28 }}
            className="absolute bottom-5 left-5 w-[min(100%-2.5rem,20rem)] overflow-hidden rounded-2xl border border-white/55 bg-white/45 shadow-[0_20px_50px_-20px_rgba(46,58,71,0.35)] backdrop-blur-xl ring-1 ring-white/40"
          >
            <div className="flex items-center justify-between border-b border-white/45 px-3.5 py-2.5">
              <div className="flex items-center gap-2">
                <PointyMark className="size-4" />
                <span className="text-xs font-semibold text-foreground/90">Pointy</span>
              </div>
              <span
                className={cn(
                  "size-2 rounded-full",
                  phase === "ask" ? "bg-signal animate-pulse" : "bg-forest/70",
                )}
              />
            </div>

            <div className="space-y-3 px-3.5 py-3.5">
              <AnimatePresence mode="wait">
                {(phase === "wake" || phase === "ask") && (
                  <motion.div
                    key="ask"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                  >
                    <p className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
                      You
                    </p>
                    <p className="mt-1 text-sm font-medium text-foreground">
                      {phase === "wake" ? "…" : "Where do I export this?"}
                    </p>
                    {phase === "ask" && (
                      <div className="mt-2 flex gap-0.5">
                        {[0, 1, 2, 3, 4].map((i) => (
                          <motion.span
                            key={i}
                            className="w-0.5 rounded-full bg-forest"
                            animate={{ height: [4, 14 + i * 2, 4] }}
                            transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.07 }}
                          />
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}

                {phase === "answer" && (
                  <motion.div
                    key="answer"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                  >
                    <p className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
                      Pointy
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-foreground">
                      Open <span className="font-semibold">File → Export</span>, then pick PDF.
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="rounded-xl border border-white/50 bg-white/35 px-3 py-2">
                <p className="text-[0.625rem] text-muted-foreground">
                  Type or speak — glass stays on your screen
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Hotkey hint */}
      <motion.div
        className="absolute top-4 right-4 flex items-center gap-2 rounded-full border border-white/60 bg-white/50 px-3 py-1.5 backdrop-blur-md"
        animate={{ opacity: phase === "idle" ? 0.5 : 1, scale: phase === "wake" ? 1.05 : 1 }}
      >
        <span className="text-[0.625rem] text-muted-foreground">Hold</span>
        <HotkeyCombo keys={["Ctrl", "Space"]} size="xs" active={phase === "wake" || phase === "ask"} />
      </motion.div>
    </div>
  );
}
