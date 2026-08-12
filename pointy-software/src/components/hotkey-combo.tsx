import { AnimatePresence, motion } from "motion/react";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/**
 * Renders a combo as individual key caps. Every place a shortcut appears in the app
 * goes through this so the keys look the same everywhere.
 */
export function HotkeyCombo({
  keys,
  size = "sm",
  active = false,
  className,
}: {
  keys: string[];
  size?: "xs" | "sm" | "lg";
  active?: boolean;
  className?: string;
}) {
  if (keys.length === 0) return null;

  return (
    <KbdGroup
      className={cn(
        size === "lg" ? "gap-2.5" : size === "sm" ? "gap-1.5" : "gap-1",
        className,
      )}
    >
      <AnimatePresence mode="popLayout">
        {keys.map((key) => (
          <motion.div
            key={key}
            layout
            initial={{ opacity: 0, scale: 0.8, y: 5 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: -5 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
          >
            <Kbd
              className={cn(
                "border font-sans transition-all duration-200 block shadow-sm relative",
                size === "lg"
                  ? "h-16 min-w-16 rounded-xl px-5 text-lg font-medium shadow-md border-b-[3px] border-border/60 hover:-translate-y-0.5"
                  : size === "sm"
                    ? "h-8 min-w-8 rounded-md px-2.5 text-sm font-medium border-b-2 border-border/60"
                    : "h-5 min-w-5 rounded-[4px] px-1.5 text-[10px] font-medium leading-none border-b",
                active
                  ? "border-accent bg-accent/15 text-foreground shadow-accent/20 border-b-accent/40 translate-y-[1px]"
                  : "bg-card text-foreground",
              )}
            >
              {key}
            </Kbd>
          </motion.div>
        ))}
      </AnimatePresence>
    </KbdGroup>
  );
}
