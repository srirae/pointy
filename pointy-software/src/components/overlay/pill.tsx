import { AnimatePresence, motion } from "motion/react";

import { VoiceVisualizer } from "@/components/overlay/voice-visualizer";

export type PillState = "idle" | "listening";

/**
 * The floating pill.
 *
 * Everything here is painted from literal colours rather than theme tokens: the app
 * itself is a light UI, but this window floats over other people's software, where only
 * a dark, low-contrast surface stays readable and unobtrusive.
 *
 * Geometry is animated on the pill, never on the window. Resizing an OS window at 60 Hz
 * tears and lags; the window stays a fixed transparent canvas and the capsule grows
 * inside it, which is what makes the expand read as one continuous material.
 */

/** Fixed widths per state — a measured layout animates far more smoothly than `auto`. */
const WIDTH = { idle: 74, listening: 226, withError: 332 };
const HEIGHT = { idle: 36, listening: 40 };

/** Spring physics for fluid resizing. */
const SPRING = { type: "spring", stiffness: 350, damping: 28 } as const;

export function Pill({
  state,
  bands,
  level,
  error,
}: {
  state: PillState;
  bands: number[];
  level: number;
  error: string | null;
}) {
  const open = state !== "idle";
  const width = open && error ? WIDTH.withError : WIDTH[state];

  return (
    <motion.div
      layout={false}
      initial={false}
      animate={{ width, height: HEIGHT[state] }}
      transition={SPRING}
      className="relative flex items-center justify-center overflow-hidden rounded-full"
      style={{
        // Near-black, not pure black: pure black looks like a hole punched in the
        // desktop. The inset hairline is what gives the capsule an edge in light rooms.
        background: "rgba(17, 19, 22, 0.94)",
        backdropFilter: "blur(20px) saturate(140%)",
        WebkitBackdropFilter: "blur(20px) saturate(140%)",
        boxShadow: [
          "inset 0 1px 0 rgba(255, 255, 255, 0.07)",
          "inset 0 0 0 1px rgba(255, 255, 255, 0.06)",
          "0 2px 6px -1px rgba(0, 0, 0, 0.45)",
          "0 12px 32px -10px rgba(0, 0, 0, 0.65)",
        ].join(", "),
      }}
    >
      {/* Idle: A small pulsating orb */}
      <AnimatePresence initial={false}>
        {!open && (
          <motion.div
            key="idle-orb"
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.5 }}
            transition={SPRING}
            className="absolute inset-0 flex items-center justify-center"
          >
            <motion.span
              animate={{ opacity: [0.3, 0.8, 0.3], scale: [0.8, 1.1, 0.8] }}
              transition={{
                duration: 2.5,
                repeat: Infinity,
                ease: "easeInOut",
              }}
              className="size-2 rounded-full"
              style={{
                background: "linear-gradient(to top, #d9a865, #ffa61f)",
                boxShadow: "0 0 8px rgba(255,166,31,0.5)",
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="live"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, filter: "blur(4px)" }}
            transition={{ ...SPRING, opacity: { duration: 0.2 } }}
            className="absolute inset-0 flex items-center gap-3 px-4"
          >
            <VoiceVisualizer bands={bands} level={level} />
            {error && <Message text={error} />}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/**
 * A short line beside the bars — only ever a microphone failure, so the pill can say
 * "Windows is blocking microphone access" instead of just sitting there flat. It fades
 * out at the left edge so an over-long message looks intentional instead of clipped.
 */
function Message({ text }: { text: string }) {
  return (
    <div
      className="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
      style={{
        maskImage: "linear-gradient(to right, transparent, #000 18px)",
        WebkitMaskImage: "linear-gradient(to right, transparent, #000 18px)",
      }}
    >
      <motion.span
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="text-[0.75rem] leading-none tracking-[-0.005em]"
        style={{ color: "#f0a094" }}
      >
        {text}
      </motion.span>
    </div>
  );
}
