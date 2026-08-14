import { motion } from "motion/react";

import type { ClickTarget } from "@/lib/pointy";

/**
 * Glow the real control's edges. Big, high-contrast, with a soft *slow* pulse
 * (never a fast blink) and a large label chip so someone with low vision knows
 * exactly what to press.
 */
export function ClickHint({ target }: { target: ClickTarget }) {
  const left = `${target.x * 100}%`;
  const top = `${target.y * 100}%`;
  const width = `${Math.max(2.5, target.w * 100)}%`;
  const height = `${Math.max(2.5, target.h * 100)}%`;

  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      <motion.div
        className="absolute rounded-xl"
        style={{
          left,
          top,
          width,
          height,
          border: "4px solid rgba(255, 146, 18, 0.98)",
          background: "rgba(255, 166, 31, 0.10)",
        }}
        initial={{ opacity: 0 }}
        animate={{
          opacity: 1,
          boxShadow: [
            "0 0 0 3px rgba(255,166,31,0.45), 0 0 26px 6px rgba(255,166,31,0.6), 0 0 60px 14px rgba(255,166,31,0.3), inset 0 0 22px rgba(255,166,31,0.12)",
            "0 0 0 3px rgba(255,166,31,0.7), 0 0 40px 10px rgba(255,166,31,0.8), 0 0 80px 20px rgba(255,166,31,0.42), inset 0 0 30px rgba(255,166,31,0.18)",
            "0 0 0 3px rgba(255,166,31,0.45), 0 0 26px 6px rgba(255,166,31,0.6), 0 0 60px 14px rgba(255,166,31,0.3), inset 0 0 22px rgba(255,166,31,0.12)",
          ],
        }}
        transition={{
          opacity: { duration: 0.25 },
          boxShadow: { duration: 2.8, repeat: Infinity, ease: "easeInOut" },
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
