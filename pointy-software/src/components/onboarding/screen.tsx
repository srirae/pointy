import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { motion } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * One question per screen — centred, calm, with the interactive stage in a single card.
 * Wispr-style: the title is the job; the lede is just-in-time context.
 */
export function Screen({
  title,
  lede,
  onBack,
  children,
  footnote,
  progressHint,
  wide = false,
}: {
  title: string;
  lede?: ReactNode;
  onBack?: () => void;
  children: ReactNode;
  footnote?: ReactNode;
  progressHint?: string;
  wide?: boolean;
}) {
  return (
    <div className="relative flex h-full flex-col items-center overflow-y-auto px-8 py-10">
      {onBack && (
        <motion.button
          type="button"
          onClick={onBack}
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.05 }}
          className="absolute top-9 left-9 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back
        </motion.button>
      )}

      {progressHint && (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute top-9 right-9 text-[0.6875rem] font-semibold tracking-[0.14em] uppercase text-muted-foreground/80"
        >
          {progressHint}
        </motion.p>
      )}

      <div
        className={cn(
          "m-auto flex w-full flex-col items-center",
          wide ? "max-w-3xl" : "max-w-2xl",
        )}
      >
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 28 }}
          className="text-center text-[2.375rem] leading-[1.08] font-bold tracking-[-0.035em] text-foreground"
        >
          {title}
        </motion.h1>
        {lede && (
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.06, type: "spring", stiffness: 380, damping: 28 }}
            className="mt-4 max-w-lg text-center text-[0.9375rem] leading-relaxed text-muted-foreground"
          >
            {lede}
          </motion.p>
        )}

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, type: "spring", stiffness: 340, damping: 28 }}
          className="mt-9 w-full"
        >
          {children}
        </motion.div>

        {footnote && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="mt-5 max-w-md text-center text-xs leading-relaxed text-muted-foreground/80"
          >
            {footnote}
          </motion.p>
        )}
      </div>
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border/60 bg-card/95 p-7 backdrop-blur-sm",
        "shadow-[0_1px_2px_rgba(46,58,71,0.04),0_22px_48px_-28px_rgba(46,58,71,0.28)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardQuestion({ children }: { children: ReactNode }) {
  return (
    <p className="text-[1.125rem] font-semibold tracking-[-0.02em] text-foreground/90">
      {children}
    </p>
  );
}

/** Inset panel that holds the thing being demonstrated. */
export function Stage({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "relative mt-5 flex items-center justify-center overflow-hidden rounded-xl bg-secondary/55 px-6 py-8",
        "ring-1 ring-inset ring-border/40",
        className,
      )}
    >
      {children}
    </div>
  );
}
