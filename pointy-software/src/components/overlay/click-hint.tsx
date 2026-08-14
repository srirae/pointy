import { motion } from "motion/react";

import type { ClickTarget } from "@/lib/pointy";

/**
 * Spotlight + pulsing ring + arrow on the real screen control.
 * Pointer-events none so the user can click through onto the app.
 */
export function ClickHint({ target }: { target: ClickTarget }) {
  const left = target.x * 100;
  const top = target.y * 100;
  const width = Math.max(2.4, target.w * 100);
  const height = Math.max(3.2, target.h * 100);
  const cx = left + width / 2;
  const cy = top + height / 2;
  const fromLeft = cx > 55;
  const fromBelow = cy < 22;

  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(circle at ${cx}% ${cy}%, transparent 0%, transparent 7%, rgba(12, 16, 20, 0.52) 18%)`,
        }}
      />

      <motion.div
        className="absolute rounded-xl"
        style={{
          left: `${left}%`,
          top: `${top}%`,
          width: `${width}%`,
          height: `${height}%`,
          boxShadow: "0 0 0 3px #ffa61f, 0 0 28px rgba(255, 166, 31, 0.45)",
        }}
        initial={{ opacity: 0, scale: 0.86 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", stiffness: 380, damping: 22 }}
      >
        <motion.span
          className="absolute inset-[-10px] rounded-2xl border-2 border-signal/80"
          animate={{ opacity: [0.25, 0.9, 0.25], scale: [1, 1.06, 1] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        />
      </motion.div>

      <motion.div
        className="absolute"
        style={{
          left: fromLeft ? `${Math.max(2, left - 18)}%` : `${Math.min(78, left + width + 2)}%`,
          top: fromBelow ? `${Math.min(88, top + height + 3)}%` : `${Math.max(4, top - 10)}%`,
        }}
        initial={{ opacity: 0, x: fromLeft ? -16 : 16, y: fromBelow ? 10 : -10 }}
        animate={{ opacity: 1, x: 0, y: 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 24, delay: 0.08 }}
      >
        <svg
          width="120"
          height="52"
          viewBox="0 0 120 52"
          fill="none"
          className="block"
          style={{ transform: fromLeft ? "scaleX(-1)" : undefined }}
        >
          <motion.path
            d="M8 10C28 8 52 14 74 26C88 34 98 38 112 40"
            stroke="#FFA61F"
            strokeWidth="3"
            strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
          />
          <path
            d="M98 30L114 40.5L96 48"
            stroke="#FFA61F"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <div
          className="mt-1 inline-flex items-center rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold tracking-[-0.01em] text-obsidian"
          style={{ background: "linear-gradient(to top, #d9a865, #ffa61f)" }}
        >
          Click {target.label}
        </div>
      </motion.div>
    </div>
  );
}
