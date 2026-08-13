import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { GuideArrow } from "@/components/guide-arrow";
import { cn } from "@/lib/utils";

const TARGETS = [
  { id: "export", label: "Export…", hint: "File › Export" },
  { id: "share", label: "Share link", hint: "Top right" },
  { id: "prefs", label: "Preferences", hint: "Settings" },
] as const;

/**
 * Miniature “stuck in an app” stage: Pointy’s guide-dot lands on the answer.
 * Loops so the welcome screen teaches the product before a single permission is asked.
 */
export function ProductDemo({ className }: { className?: string }) {
  const [index, setIndex] = useState(0);
  const [pointing, setPointing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timers: number[] = [];

    const cycle = () => {
      if (cancelled) return;
      setPointing(false);
      timers.push(
        window.setTimeout(() => {
          if (cancelled) return;
          setPointing(true);
        }, 480),
        window.setTimeout(() => {
          if (cancelled) return;
          setPointing(false);
        }, 2800),
        window.setTimeout(() => {
          if (cancelled) return;
          setIndex((i) => (i + 1) % TARGETS.length);
          cycle();
        }, 3400),
      );
    };

    cycle();
    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  const target = TARGETS[index];

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border/60 bg-card/90 shadow-[0_24px_64px_-28px_rgba(46,58,71,0.45)]",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-border/50 bg-secondary/40 px-4 py-2.5">
        <span className="size-2 rounded-full bg-foreground/15" />
        <span className="size-2 rounded-full bg-foreground/15" />
        <span className="size-2 rounded-full bg-foreground/15" />
        <span className="ml-3 text-[0.6875rem] font-medium tracking-wide text-muted-foreground">
          Design file — Untitled
        </span>
      </div>

      <div className="relative grid grid-cols-[4.5rem_1fr] gap-0">
        <aside className="flex flex-col gap-2 border-r border-border/40 bg-secondary/25 px-2.5 py-4">
          {["Layers", "Assets", "Pages"].map((item) => (
            <div
              key={item}
              className="rounded-md px-2 py-1.5 text-[0.625rem] font-medium text-muted-foreground/80"
            >
              {item}
            </div>
          ))}
        </aside>

        <div className="relative min-h-[13.5rem] bg-[linear-gradient(160deg,#f7f8fa_0%,#eef1f4_55%,#e8ecef_100%)] p-6">
          <div className="absolute inset-0 opacity-[0.4]" style={{
            backgroundImage:
              "linear-gradient(rgb(46 58 71 / 0.04) 1px, transparent 1px), linear-gradient(90deg, rgb(46 58 71 / 0.04) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
          }} />

          <div className="relative flex h-full flex-col items-end justify-between">
            <div className="self-start rounded-lg border border-border/50 bg-card/80 px-3 py-2 shadow-sm">
              <p className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                You asked
              </p>
              <AnimatePresence mode="wait">
                <motion.p
                  key={target.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.28 }}
                  className="mt-1 max-w-[18ch] text-[0.8125rem] font-medium leading-snug text-foreground"
                >
                  “Where’s {target.label.replace("…", "")}?”
                </motion.p>
              </AnimatePresence>
            </div>

            <div className="relative mr-2 mb-1">
              <GuideArrow visible={pointing} />
              <AnimatePresence mode="wait">
                <motion.button
                  key={target.id}
                  type="button"
                  tabIndex={-1}
                  initial={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  className={cn(
                    "pointer-events-none rounded-lg border px-4 py-2 text-sm font-medium shadow-sm transition-colors",
                    pointing
                      ? "border-signal/50 bg-card text-foreground ring-2 ring-signal/35"
                      : "border-border/70 bg-card text-foreground",
                  )}
                >
                  {target.label}
                </motion.button>
              </AnimatePresence>
              <p className="mt-2 text-right text-[0.625rem] text-muted-foreground">
                {target.hint}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
