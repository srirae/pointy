import { motion } from "motion/react";

import type { ClickTarget } from "@/lib/pointy";

/**
 * Glow the real control's edges, and nothing else.
 *
 * The box is resolved from the accessibility tree at the moment the user asks to
 * be shown, so it hugs the actual control. A soft *slow* pulse (never a fast
 * blink) plus a large label chip keeps it readable for someone with low vision.
 *
 * When `flash` is true a misclick warning just fired, so the border briefly
 * burns hotter and faster to pull the eye back to the right control.
 */
export function ClickHint({ target, flash }: { target: ClickTarget; flash?: boolean }) {
  const calm = [
    "0 0 0 3px rgba(255,166,31,0.45), 0 0 26px 6px rgba(255,166,31,0.6), 0 0 60px 14px rgba(255,166,31,0.3), inset 0 0 22px rgba(255,166,31,0.12)",
    "0 0 0 3px rgba(255,166,31,0.7), 0 0 40px 10px rgba(255,166,31,0.8), 0 0 80px 20px rgba(255,166,31,0.42), inset 0 0 30px rgba(255,166,31,0.18)",
    "0 0 0 3px rgba(255,166,31,0.45), 0 0 26px 6px rgba(255,166,31,0.6), 0 0 60px 14px rgba(255,166,31,0.3), inset 0 0 22px rgba(255,166,31,0.12)",
  ];
  const alarm = [
    "0 0 0 4px rgba(255,90,31,0.85), 0 0 46px 12px rgba(255,90,31,0.9), 0 0 90px 24px rgba(255,166,31,0.5), inset 0 0 34px rgba(255,90,31,0.22)",
    "0 0 0 3px rgba(255,166,31,0.5), 0 0 28px 7px rgba(255,166,31,0.65), 0 0 64px 16px rgba(255,166,31,0.32), inset 0 0 24px rgba(255,166,31,0.14)",
    "0 0 0 4px rgba(255,90,31,0.85), 0 0 46px 12px rgba(255,90,31,0.9), 0 0 90px 24px rgba(255,166,31,0.5), inset 0 0 34px rgba(255,90,31,0.22)",
  ];

  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      <motion.div
        className="absolute rounded-xl"
        style={{
          left: `${target.x * 100}%`,
          top: `${target.y * 100}%`,
          width: `${Math.max(2.5, target.w * 100)}%`,
          height: `${Math.max(2.5, target.h * 100)}%`,
          border: flash ? "4px solid rgba(255, 90, 31, 0.98)" : "4px solid rgba(255, 146, 18, 0.98)",
          background: "rgba(255, 166, 31, 0.10)",
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, boxShadow: flash ? alarm : calm }}
        transition={{
          opacity: { duration: 0.25 },
          boxShadow: {
            duration: flash ? 0.7 : 2.8,
            repeat: Infinity,
            ease: "easeInOut",
          },
        }}
      >
        <motion.span
          className="absolute -top-9 left-0 max-w-[16rem] truncate rounded-full px-3.5 py-1.5 text-[1rem] font-bold text-[#2e3a47]"
          style={{
            background: "rgba(255, 255, 255, 0.98)",
            boxShadow: "0 6px 18px -6px rgba(46, 58, 71, 0.5)",
          }}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.2 }}
        >
          {target.label || "This one"}
        </motion.span>
      </motion.div>
    </div>
  );
}
