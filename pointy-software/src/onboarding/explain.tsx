import { useState } from "react";
import { motion } from "motion/react";

import { GlassPreview } from "@/components/onboarding/glass-preview";
import { DEMO_BEATS, ProductDemoReel } from "@/components/onboarding/product-demo-reel";
import { Screen } from "@/components/onboarding/screen";
import { StepNav } from "@/components/onboarding/step-nav";
import { progressLabel } from "@/lib/onboarding-flow";

/**
 * Step 2 — auto demo reel + glass panel visual (voice wake + text, not clickable).
 */
export function Explain({
  onBack,
  onNext,
}: {
  onBack?: () => void;
  onNext: () => void;
}) {
  const [index, setIndex] = useState(0);
  const beat = DEMO_BEATS[index]!;

  return (
    <Screen
      title="Wake it. Ask out loud. Or type."
      lede="Pointy lives in a glass panel on your screen — voice-first, text when you want it."
      progressHint={progressLabel("explain")}
      wide
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <ProductDemoReel onBeatChange={setIndex} />
        <GlassPreview />
      </div>

      <motion.div
        key={beat.id}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto mt-6 max-w-lg text-center"
      >
        <p className="font-serif text-[1.35rem] leading-tight tracking-tight text-foreground">
          {beat.title}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{beat.body}</p>
      </motion.div>

      <StepNav onBack={onBack} onNext={onNext} backDisabled={!onBack} />
    </Screen>
  );
}
