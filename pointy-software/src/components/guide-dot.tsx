import { motion } from "motion/react";

import { cn } from "@/lib/utils";

/** Pulsing Signal Ochre guide-dot — the product’s pointing mark. */
export function GuideDot({
  className,
  size = "md",
  label,
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
  label?: string | number;
}) {
  const dim = size === "lg" ? "size-5" : size === "sm" ? "size-2.5" : "size-3.5";

  return (
    <span className={cn("relative inline-flex items-center justify-center", className)}>
      <motion.span
        className={cn("absolute rounded-full bg-signal/45", dim)}
        animate={{ scale: [1, 2.4], opacity: [0.55, 0] }}
        transition={{ duration: 1.5, repeat: Infinity, ease: "easeOut" }}
      />
      <span
        className={cn(
          "relative z-10 flex items-center justify-center rounded-full bg-signal font-semibold text-obsidian shadow-[0_0_0_2px_rgba(255,255,255,0.85)]",
          dim,
          label != null ? "text-[0.625rem]" : "",
        )}
      >
        {label}
      </span>
    </span>
  );
}
