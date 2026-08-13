import { motion } from "motion/react";

import { HotkeyCombo } from "@/components/hotkey-combo";
import { Atmosphere } from "@/components/onboarding/atmosphere";
import { PointyMark } from "@/components/pointy-mark";
import { Button } from "@/components/ui/button";
import type { Combo } from "@/lib/pointy";

/** Post-onboarding — one clear message with the hotkey they chose. */
export function AllSet({
  combo,
  onSetupAgain,
}: {
  combo: Combo | null;
  onSetupAgain: () => void;
}) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center px-8">
      <Atmosphere />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 320, damping: 28 }}
        className="relative z-10 flex max-w-md flex-col items-center text-center"
      >
        <div className="flex size-14 items-center justify-center rounded-2xl bg-card shadow-[0_16px_40px_-20px_rgba(13,74,71,0.4)] ring-1 ring-border/50">
          <PointyMark className="size-8" />
        </div>

        <h1 className="mt-8 font-serif text-[2rem] leading-tight tracking-tight text-foreground">
          You’re all set
        </h1>

        <p className="mt-4 text-[0.975rem] leading-relaxed text-muted-foreground">
          Pointy runs in the background. Hold your hotkey — the glass panel wakes up. Speak or type your question.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5 rounded-2xl border border-border/60 bg-card/90 px-6 py-5 shadow-sm">
          <span className="text-sm text-muted-foreground">Hold</span>
          {combo ? (
            <HotkeyCombo keys={combo.keys} size="sm" />
          ) : (
            <span className="text-sm font-medium">your hotkey</span>
          )}
          <span className="text-sm text-muted-foreground">to wake Pointy</span>
        </div>

        <p className="mt-6 text-xs text-muted-foreground/85">
          Frosted glass on your screen — answers and a guide-dot, not a chat wall.
        </p>

        <Button
          variant="ghost"
          size="sm"
          className="mt-10 text-muted-foreground"
          onClick={onSetupAgain}
        >
          Run setup again
        </Button>
      </motion.div>
    </div>
  );
}
