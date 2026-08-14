import { ChevronLeft, ChevronRight } from "lucide-react";
import { motion } from "motion/react";

import { Button } from "@/components/ui/button";

/** Shared back / forward controls for every onboarding step. */
export function StepNav({
  onBack,
  onNext,
  backDisabled,
  nextDisabled,
  nextLabel = "Continue",
  nextReady = false,
  className,
}: {
  onBack?: () => void;
  onNext?: () => void;
  backDisabled?: boolean;
  nextDisabled?: boolean;
  nextLabel?: string;
  /** When true, the Continue button plays a subtle enable animation. */
  nextReady?: boolean;
  className?: string;
}) {
  return (
    <div className={`mt-8 flex items-center justify-between gap-4 ${className ?? ""}`}>
      <Button
        variant="ghost"
        size="sm"
        disabled={backDisabled || !onBack}
        onClick={onBack}
        className="gap-1 text-muted-foreground"
      >
        <ChevronLeft className="size-4" aria-hidden />
        Back
      </Button>
      <motion.div
        initial={false}
        animate={
          nextReady
            ? {
                scale: [1, 1.04, 1],
                boxShadow: [
                  "0 0 0 rgba(13,74,71,0)",
                  "0 12px 28px -12px rgba(13,74,71,0.45)",
                  "0 8px 20px -14px rgba(13,74,71,0.35)",
                ],
              }
            : { scale: 1 }
        }
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        className="rounded-xl"
      >
        <Button
          disabled={nextDisabled || !onNext}
          onClick={onNext}
          className="gap-1 rounded-xl px-7 disabled:pointer-events-none disabled:opacity-40"
        >
          {nextLabel}
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </motion.div>
    </div>
  );
}
