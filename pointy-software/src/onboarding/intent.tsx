import { useState } from "react";

import { LiveSandbox } from "@/components/onboarding/live-sandbox";
import { Screen } from "@/components/onboarding/screen";
import { Button } from "@/components/ui/button";

/**
 * Interactive product lesson before permissions.
 * User picks a software surface, watches a person ask, gets Pointy’s answer,
 * and can reveal the pointer path — so the mental model is earned, not explained.
 */
export function Intent({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [experienced, setExperienced] = useState(false);

  return (
    <Screen
      title="See Pointy work once"
      lede="Pick any software below. Watch someone get stuck, hear the answer, then turn on the pointer to see exactly where to click."
      onBack={onBack}
      wide
    >
      <LiveSandbox onExperienced={() => setExperienced(true)} />

      <div className="mt-6 flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          {experienced
            ? "Nice — that’s the product. Next we’ll ask for the permissions that make it real."
            : "Try one example to continue. Takes about ten seconds."}
        </p>
        <Button disabled={!experienced} onClick={onNext} className="shrink-0 rounded-xl px-6">
          Continue
        </Button>
      </div>
    </Screen>
  );
}
