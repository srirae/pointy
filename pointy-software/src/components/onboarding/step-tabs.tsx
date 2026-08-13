import { ChevronRight } from "lucide-react";

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
 * Top step rail — uppercase labels split by chevrons, with a hairline that
 * fills across the bar as setup advances. Purely a progress indicator:
 * labels are not clickable, so users can’t skip back and forth mid-setup.
 */
export function StepTabs({ current }: { current: StepId }) {
  const index = stepIndex(current);
  const hide = current === "welcome";
  // Welcome is the cinematic first beat and owns its own branding, so the rail
  // shows the three setup steps. The fill reaches 100% on the last one.
  const rail = STEPS.filter((step) => step.id !== "welcome");
  const progress = Math.round((index / (STEPS.length - 1)) * 100);

  return (
    <header
      className={cn(
        "relative z-10 shrink-0 border-b border-border/50 bg-background/70 backdrop-blur-md",
        hide && "pointer-events-none opacity-0",
      )}
    >
      <div className="flex h-14 items-center px-6">
        <div className="flex w-40 shrink-0 items-center gap-2.5">
          <PointyMark className="size-5" />
          <span className="text-[0.6875rem] font-semibold tracking-[0.2em] uppercase text-foreground/80">
            Pointy
          </span>
        </div>

        <nav
          className="flex flex-1 items-center justify-center gap-1"
          aria-label="Setup steps"
        >
          {rail.map((step, i) => {
            const at = stepIndex(step.id);
            const active = at === index;
            const done = at < index;
            return (
              <div key={step.id} className="flex items-center">
                {i > 0 && (
                  <ChevronRight
                    className="mx-6 size-4 shrink-0 text-foreground/20"
                    aria-hidden
                  />
                )}
                <span
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "px-1 py-2 text-[0.6875rem] tracking-[0.16em] uppercase select-none",
                    active
                      ? "font-bold text-foreground"
                      : done
                        ? "font-semibold text-foreground/70"
                        : "font-medium text-muted-foreground/70",
                  )}
                >
                  {step.label}
                </span>
              </div>
            );
          })}
        </nav>

        <div className="w-40 shrink-0" aria-hidden />
      </div>

      {/* Hairline that grows along the bar — the whole progress signal. */}
      <div aria-hidden className="absolute inset-x-0 -bottom-px h-[2px]">
        <div
          className="h-full bg-forest transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </header>
  );
}
