import { PointyMark } from "@/components/pointy-mark";
import { cn } from "@/lib/utils";

export const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "explain", label: "Product" },
  { id: "hotkey", label: "Hotkey" },
  { id: "speak", label: "Speak" },
] as const;

export type StepId = (typeof STEPS)[number]["id"];

export function stepIndex(step: StepId) {
  return STEPS.findIndex((entry) => entry.id === step);
}

/**
 * Clickable step rail — jump back or forward anywhere in setup.
 */
export function StepTabs({
  current,
  onStep,
}: {
  current: StepId;
  onStep: (step: StepId) => void;
}) {
  const index = stepIndex(current);
  const hide = current === "welcome";

  return (
    <header
      className={cn(
        "relative z-10 flex shrink-0 items-center justify-between px-8 py-4 transition-opacity",
        hide && "pointer-events-none opacity-0",
      )}
    >
      <div className="flex items-center gap-2.5">
        <PointyMark className="size-5" />
        <span className="text-[0.75rem] font-semibold tracking-[0.2em] uppercase text-foreground/90">
          Pointy
        </span>
      </div>

      <nav className="flex items-center gap-1" aria-label="Setup steps">
        {STEPS.map((step, i) => {
          if (step.id === "welcome") return null;
          const active = i === index;
          const done = i < index;
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => onStep(step.id)}
              className={cn(
                "rounded-full px-3 py-1.5 text-[0.6875rem] font-semibold tracking-wide transition-all",
                active
                  ? "bg-forest text-white shadow-sm"
                  : done
                    ? "bg-ochre/15 text-foreground hover:bg-ochre/25"
                    : "text-muted-foreground hover:bg-secondary/80 hover:text-foreground",
              )}
            >
              {step.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
}
