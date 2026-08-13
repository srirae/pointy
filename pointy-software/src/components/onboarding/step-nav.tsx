import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Shared back / forward controls for every onboarding step. */
export function StepNav({
  onBack,
  onNext,
  backDisabled,
  nextDisabled,
  nextLabel = "Continue",
  className,
}: {
  onBack?: () => void;
  onNext?: () => void;
  backDisabled?: boolean;
  nextDisabled?: boolean;
  nextLabel?: string;
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
      <Button
        disabled={nextDisabled || !onNext}
        onClick={onNext}
        className="gap-1 rounded-xl px-7"
      >
        {nextLabel}
        <ChevronRight className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
