import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

export const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "permissions", label: "Permissions" },
  { id: "hotkey", label: "Hotkey" },
  { id: "microphone", label: "Microphone" },
  { id: "done", label: "Done" },
] as const;

export type StepId = (typeof STEPS)[number]["id"];

export function stepIndex(step: StepId) {
  return STEPS.findIndex((entry) => entry.id === step);
}

/**
 * Setup progress across the top of the window: the current step named, the ones behind
 * it dimmed, and a hairline that fills as the user moves forward.
 */
export function StepTabs({ current }: { current: StepId }) {
  const index = stepIndex(current);
  const progress = ((index + 1) / STEPS.length) * 100;

  return (
    <header className="relative shrink-0 bg-card">
      <nav className="flex items-center justify-center gap-1 py-4">
        {STEPS.map((step, i) => (
          <div key={step.id} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 text-foreground/20" aria-hidden />}
            <span
              aria-current={i === index ? "step" : undefined}
              className={cn(
                "px-4 text-[0.6875rem] font-semibold tracking-[0.14em] uppercase transition-colors",
                i === index ? "text-foreground" : "text-muted-foreground/70",
              )}
            >
              {step.label}
            </span>
          </div>
        ))}
      </nav>

      <div className="absolute inset-x-0 bottom-0 h-px bg-foreground/10">
        <div
          className="h-[2px] bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </header>
  );
}
