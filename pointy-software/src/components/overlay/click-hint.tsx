import { motion } from "motion/react";

import type { ClickTarget } from "@/lib/pointy";

/**
 * Glow the real control's edges. No arrow, no fake center box — the model box
 * is drawn as a pulsing border the user can click through.
 */
export function ClickHint({ target }: { target: ClickTarget }) {
  const left = `${target.x * 100}%`;
  const top = `${target.y * 100}%`;
  const width = `${Math.max(0.8, target.w * 100)}%`;
  const height = `${Math.max(0.8, target.h * 100)}%`;

  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
      <motion.div
        className="absolute rounded-md"
        style={{
          left,
          top,
          width,
          height,
          border: "2px solid rgba(255, 166, 31, 0.95)",
          boxShadow: [
            "0 0 0 1px rgba(255, 166, 31, 0.35)",
            "0 0 18px 2px rgba(255, 166, 31, 0.55)",
            "0 0 42px 6px rgba(255, 166, 31, 0.28)",
            "inset 0 0 18px rgba(255, 166, 31, 0.12)",
          ].join(", "),
          background: "transparent",
        }}
        initial={{ opacity: 0 }}
        animate={{
          opacity: 1,
          boxShadow: [
            "0 0 0 1px rgba(255,166,31,0.3), 0 0 14px 2px rgba(255,166,31,0.4), 0 0 32px 4px rgba(255,166,31,0.2), inset 0 0 12px rgba(255,166,31,0.08)",
            "0 0 0 1px rgba(255,166,31,0.55), 0 0 24px 4px rgba(255,166,31,0.7), 0 0 52px 8px rgba(255,166,31,0.35), inset 0 0 20px rgba(255,166,31,0.16)",
            "0 0 0 1px rgba(255,166,31,0.3), 0 0 14px 2px rgba(255,166,31,0.4), 0 0 32px 4px rgba(255,166,31,0.2), inset 0 0 12px rgba(255,166,31,0.08)",
          ],
        }}
        transition={{
          opacity: { duration: 0.18 },
          boxShadow: { duration: 1.6, repeat: Infinity, ease: "easeInOut" },
        }}
      />
    </div>
  );
}
