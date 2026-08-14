import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { Dashboard } from "@/components/dashboard/dashboard";
import { Atmosphere } from "@/components/onboarding/atmosphere";
import { StepTabs, type StepId } from "@/components/onboarding/step-tabs";
import { Explain } from "@/onboarding/explain";
import { Hotkey } from "@/onboarding/hotkey";
import { WakeSpeak } from "@/onboarding/wake-speak";
import { Welcome } from "@/onboarding/welcome";
import { nextStep, prevStep } from "@/lib/onboarding-flow";
import { registerGlobalHotkey, unregisterGlobalHotkeys } from "@/lib/global-shortcut";
import {
  overlaySetEnabled,
  settingsFinishOnboarding,
  settingsGet,
  settingsReset,
  type Combo,
} from "@/lib/pointy";
import {
  loadPersisted,
  markSetupComplete,
  saveOnboardingStep,
  wipeSetup,
} from "@/lib/store";

type View = { kind: "loading" } | { kind: "onboarding"; step: StepId } | { kind: "home" };

export default function App() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [combo, setCombo] = useState<Combo | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const persisted = await loadPersisted();
        const settings = await settingsGet().catch(() => null);
        const keys = persisted.customHotkey ?? settings?.hotkey?.keys ?? null;
        const complete = persisted.hasCompletedSetup || Boolean(settings?.onboarding_complete && keys);

        if (keys?.length) {
          setCombo({ keys });
          void registerGlobalHotkey(keys).catch(() => {});
        }

        if (complete && keys?.length) {
          setCombo({ keys });
          await markSetupComplete({ keys });
          setView({ kind: "home" });
          return;
        }

        const step = persisted.onboardingStep && persisted.onboardingStep !== "welcome"
          ? persisted.onboardingStep
          : "welcome";
        setView({ kind: "onboarding", step: keys && step === "speak" ? "speak" : step });
      } catch {
        setView({ kind: "onboarding", step: "welcome" });
      }
    })();
  }, []);

  useEffect(() => {
    if (view.kind === "loading") return;
    const enable =
      view.kind === "home" || (view.kind === "onboarding" && view.step === "speak");
    void overlaySetEnabled(enable);
  }, [view]);

  const go = (step: StepId) => {
    setView({ kind: "onboarding", step });
    void saveOnboardingStep(step);
  };

  const finishSetup = async () => {
    if (combo) await markSetupComplete(combo);
    await settingsFinishOnboarding();
    setView({ kind: "home" });
  };

  const setupAgain = async () => {
    await wipeSetup();
    await unregisterGlobalHotkeys();
    await settingsReset();
    setCombo(null);
    setView({ kind: "onboarding", step: "welcome" });
  };

  if (view.kind === "loading") {
    return (
      <div className="relative flex h-full items-center justify-center">
        <Atmosphere />
        <Loader2 className="relative z-10 size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (view.kind === "home") {
    return (
      <Dashboard combo={combo} onComboChange={setCombo} onSetupAgain={() => void setupAgain()} />
    );
  }

  const goNext = () => {
    const next = nextStep(view.step);
    if (next) go(next);
  };
  const goBack = () => {
    const prev = prevStep(view.step);
    if (prev) go(prev);
  };

  return (
    <div className="relative flex h-full flex-col">
      <Atmosphere />
      <StepTabs current={view.step} />

      <main className="relative z-10 min-h-0 flex-1">
        <AnimatePresence mode="wait">
          <motion.div
            key={view.step}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0"
          >
            {view.step === "welcome" && <Welcome onNext={goNext} />}

            {view.step === "explain" && <Explain onBack={goBack} onNext={goNext} />}

            {view.step === "hotkey" && (
              <Hotkey
                initial={combo}
                onComboChange={setCombo}
                onBack={goBack}
                onNext={goNext}
              />
            )}

            {view.step === "speak" && combo && (
              <WakeSpeak combo={combo} onBack={goBack} onFinish={() => void finishSetup()} />
            )}

            {view.step === "speak" && !combo && (
              <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
                <p className="text-sm text-muted-foreground">
                  Pick a hotkey first — then you can try speaking.
                </p>
                <button
                  type="button"
                  onClick={() => go("hotkey")}
                  className="text-sm font-medium text-forest underline-offset-4 hover:underline"
                >
                  Go to hotkey step
                </button>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
