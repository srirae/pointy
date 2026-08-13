import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { GuideDot } from "@/components/guide-dot";
import { PointyMark } from "@/components/pointy-mark";
import { cn } from "@/lib/utils";

export type DemoBeat = {
  id: string;
  title: string;
  body: string;
};

const CLIPS: DemoBeat[] = [
  {
    id: "ask",
    title: "You ask out loud",
    body: "Hold your hotkey and say what you’re stuck on.",
  },
  {
    id: "see",
    title: "Pointy reads that screen",
    body: "One screenshot at the moment you ask — nothing in the background.",
  },
  {
    id: "point",
    title: "The guide-dot lands",
    body: "A short answer, then a pointer on the exact control.",
  },
  {
    id: "done",
    title: "Then it gets out of the way",
    body: "Pointy waits in the background until you call it again.",
  },
];

/** Auto-playing mini demos — visual only, not interactive. */
export function ProductDemoReel({
  intervalMs = 4500,
  onBeatChange,
}: {
  intervalMs?: number;
  onBeatChange?: (index: number) => void;
}) {
  const [index, setIndex] = useState(0);
  const beat = CLIPS[index]!;

  useEffect(() => {
    onBeatChange?.(index);
  }, [index, onBeatChange]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setIndex((i) => (i + 1) % CLIPS.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return (
    <div className="pointer-events-none select-none">
      <div className="relative mx-auto aspect-[16/10] w-full max-w-2xl overflow-hidden rounded-2xl border border-border/60 bg-[#1a2229] shadow-[0_28px_60px_-32px_rgba(46,58,71,0.55)]">
        <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-white/10 bg-black/30 px-3 py-2">
          <span className="size-2 rounded-full bg-white/20" />
          <span className="size-2 rounded-full bg-white/20" />
          <span className="size-2 rounded-full bg-white/20" />
          <span className="ml-2 text-[0.625rem] font-medium text-white/50">Pointy demo</span>
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={beat.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="absolute inset-0 pt-8"
          >
            {beat.id === "ask" && <AskClip />}
            {beat.id === "see" && <SeeClip />}
            {beat.id === "point" && <PointClip />}
            {beat.id === "done" && <DoneClip />}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="mt-4 flex justify-center gap-2" aria-hidden>
        {CLIPS.map((clip, i) => (
          <span
            key={clip.id}
            className={cn(
              "h-1 rounded-full transition-all duration-500",
              i === index ? "w-7 bg-forest" : "w-2 bg-foreground/15",
            )}
          />
        ))}
      </div>
    </div>
  );
}

export { CLIPS as DEMO_BEATS };

function AskClip() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8">
      <motion.div
        className="flex size-16 items-center justify-center rounded-full bg-forest/30 ring-2 ring-signal/40"
        animate={{ scale: [1, 1.08, 1] }}
        transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
      >
        <PointyMark className="size-8" />
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl bg-white/10 px-4 py-3 text-center text-sm text-white/90"
      >
        “Where do I export this?”
      </motion.div>
      <div className="flex gap-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <motion.span
            key={i}
            className="w-1 rounded-full bg-signal"
            animate={{ height: [8, 22 + i * 3, 8] }}
            transition={{ duration: 0.7, repeat: Infinity, delay: i * 0.08 }}
          />
        ))}
      </div>
    </div>
  );
}

function SeeClip() {
  return (
    <div className="relative h-full p-6 pt-10">
      <motion.div
        className="h-full rounded-xl border border-white/10 bg-[#eef1f4] p-4"
        initial={{ opacity: 0.6 }}
        animate={{ opacity: [0.6, 1, 0.85] }}
        transition={{ duration: 2, repeat: Infinity }}
      >
        <div className="mb-3 flex gap-2">
          {["File", "Edit", "View"].map((t) => (
            <span key={t} className="rounded bg-white px-2 py-0.5 text-[0.6rem] text-[#333]">
              {t}
            </span>
          ))}
        </div>
        <div className="space-y-2">
          <div className="h-2 w-3/4 rounded bg-[#333]/10" />
          <div className="h-2 w-1/2 rounded bg-[#333]/10" />
          <div className="h-2 w-2/3 rounded bg-[#333]/10" />
        </div>
      </motion.div>
      <motion.div
        className="absolute inset-6 top-12 rounded-xl border-2 border-signal/60 bg-signal/10"
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 1, 0.3, 1] }}
        transition={{ duration: 2, repeat: Infinity }}
      />
      <p className="absolute bottom-8 left-1/2 -translate-x-1/2 text-xs text-white/60">
        Reading the screen…
      </p>
    </div>
  );
}

function PointClip() {
  return (
    <div className="relative flex h-full items-center justify-center p-8 pt-12">
      <div className="relative w-full max-w-xs rounded-xl border border-white/10 bg-[#eef1f4] p-6">
        <div className="flex justify-end">
          <motion.span
            className="relative rounded-lg border border-[#333]/20 bg-white px-3 py-1.5 text-xs font-medium text-[#333]"
            animate={{ boxShadow: ["0 0 0 0 rgba(255,166,31,0)", "0 0 0 6px rgba(255,166,31,0.35)", "0 0 0 0 rgba(255,166,31,0)"] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          >
            Export…
            <span className="absolute -right-1 -bottom-1">
              <GuideDot size="sm" />
            </span>
          </motion.span>
        </div>
        <p className="mt-6 text-[0.65rem] text-[#333]/70">File → Export → PDF</p>
      </div>
    </div>
  );
}

function DoneClip() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8 pt-4">
      <motion.div
        animate={{ opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 2.5, repeat: Infinity }}
        className="flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-2"
      >
        <PointyMark className="size-5" />
        <span className="text-xs text-white/70">Running in the background</span>
      </motion.div>
      <p className="max-w-[24ch] text-center text-sm text-white/50">
        Out of your way until you hold your hotkey again.
      </p>
    </div>
  );
}
