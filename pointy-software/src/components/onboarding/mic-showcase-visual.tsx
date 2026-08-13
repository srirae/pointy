import { motion } from "motion/react";

import { PointyMark } from "@/components/pointy-mark";
import { cn } from "@/lib/utils";

const BAR_COUNT = 48;

function qualityCopy(level: number, heard: boolean) {
  if (!heard && level < 0.04) return { label: "Waiting for your voice…", tone: "muted" as const };
  if (!heard) return { label: "Almost there — speak a little louder", tone: "warm" as const };
  if (level > 0.45) return { label: "Crystal clear — your mic is perfect", tone: "great" as const };
  if (level > 0.2) return { label: "Sounds great — Pointy will hear you clearly", tone: "good" as const };
  return { label: "Good — keep talking naturally", tone: "good" as const };
}

/**
 * Voice-reactive centerpiece: orb, radial bars, ripples — all driven by live mic levels.
 */
export function MicShowcaseVisual({
  level,
  bands,
  heard,
}: {
  level: number;
  bands: number[];
  heard: boolean;
}) {
  const energy = Math.min(1, level * 2.2);
  const copy = qualityCopy(level, heard);

  return (
    <div className="relative flex min-h-[22rem] flex-col items-center justify-center overflow-hidden rounded-2xl border border-border/50 bg-gradient-to-b from-card via-secondary/30 to-forest/[0.06]">
      {/* Ambient glow */}
      <motion.div
        className="pointer-events-none absolute inset-0"
        animate={{
          opacity: 0.35 + energy * 0.45,
          scale: 1 + energy * 0.08,
        }}
        transition={{ type: "spring", stiffness: 200, damping: 28 }}
        style={{
          background:
            "radial-gradient(circle at 50% 42%, rgba(255,166,31,0.22) 0%, rgba(13,74,71,0.12) 38%, transparent 68%)",
        }}
      />

      {/* Ripple rings */}
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="pointer-events-none absolute top-[42%] left-1/2 size-48 -translate-x-1/2 -translate-y-1/2 rounded-full border border-signal/30"
          animate={{
            scale: 1 + energy * (0.35 + i * 0.15),
            opacity: heard ? 0.15 + energy * (0.35 - i * 0.08) : 0.06,
          }}
          transition={{ type: "spring", stiffness: 260, damping: 24, delay: i * 0.04 }}
        />
      ))}

      {/* Radial waveform */}
      <div className="relative size-56">
        {Array.from({ length: BAR_COUNT }, (_, i) => {
          const bandIndex = Math.floor((i / BAR_COUNT) * bands.length);
          const band = bands[bandIndex] ?? 0;
          const height = 10 + band * 44 + energy * 18;
          const angle = (i / BAR_COUNT) * 360;
          return (
            <motion.div
              key={i}
              className={cn(
                "absolute top-1/2 left-1/2 w-1 rounded-full",
                heard ? "bg-signal/75" : "bg-forest/30",
              )}
              style={{
                height,
                marginLeft: -2,
                marginTop: -height,
                transformOrigin: "bottom center",
                transform: `rotate(${angle}deg) translateY(-74px)`,
              }}
              animate={{ opacity: 0.4 + band * 0.6 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
            />
          );
        })}

        {/* Core orb */}
        <motion.div
          className="absolute top-1/2 left-1/2 flex size-24 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-card shadow-[0_0_0_1px_rgba(46,58,71,0.08),0_20px_50px_-20px_rgba(13,74,71,0.45)]"
          animate={{
            scale: 1 + energy * 0.18,
            boxShadow: heard
              ? `0 0 ${24 + energy * 40}px rgba(255,166,31,${0.25 + energy * 0.35})`
              : "0 0 0 rgba(255,166,31,0)",
          }}
          transition={{ type: "spring", stiffness: 300, damping: 22 }}
        >
          <motion.div
            animate={{ rotate: heard ? [0, 4, -4, 0] : 0 }}
            transition={{ duration: 0.6, repeat: heard ? Infinity : 0, repeatDelay: 0.2 }}
          >
            <PointyMark className="size-10" />
          </motion.div>
        </motion.div>
      </div>

      {/* Live level strip */}
      <div className="relative z-10 mt-2 flex w-full max-w-xs flex-col items-center gap-3 px-6">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
          <motion.div
            className={cn(
              "h-full rounded-full",
              heard ? "bg-gradient-to-r from-forest via-ochre to-signal" : "bg-forest/40",
            )}
            animate={{ width: `${Math.max(4, energy * 100)}%` }}
            transition={{ type: "spring", stiffness: 380, damping: 28 }}
          />
        </div>
        <motion.p
          key={copy.label}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            "text-center text-sm font-medium",
            copy.tone === "great" && "text-forest",
            copy.tone === "good" && "text-foreground",
            copy.tone === "warm" && "text-ochre",
            copy.tone === "muted" && "text-muted-foreground",
          )}
        >
          {copy.label}
        </motion.p>
      </div>

      {/* Floating particles when speaking */}
      {heard && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          {Array.from({ length: 6 }, (_, i) => (
            <motion.span
              key={i}
              className="absolute size-1 rounded-full bg-signal/70"
              style={{ left: `${18 + i * 14}%`, bottom: "18%" }}
              animate={{
                y: [0, -40 - i * 8, 0],
                opacity: [0, 0.8, 0],
                scale: [0.5, 1, 0.5],
              }}
              transition={{
                duration: 1.8 + i * 0.2,
                repeat: Infinity,
                delay: i * 0.25,
                ease: "easeOut",
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
