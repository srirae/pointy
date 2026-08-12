import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { HotkeyCombo } from "@/components/hotkey-combo";
import { PointyMark } from "@/components/pointy-mark";
import { StepTabs, type StepId } from "@/components/onboarding/step-tabs";
import { Button } from "@/components/ui/button";
import { useHotkeyPress } from "@/hooks/use-hotkey";
import { Done } from "@/onboarding/done";
import { Hotkey } from "@/onboarding/hotkey";
import { MicTest } from "@/onboarding/mic-test";
import { Permissions } from "@/onboarding/permissions";
import { Welcome } from "@/onboarding/welcome";
import { settingsGet, type Combo } from "@/lib/pointy";

type View = { kind: "loading" } | { kind: "onboarding"; step: StepId } | { kind: "home" };

export default function App() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [combo, setCombo] = useState<Combo | null>(null);
  const [device, setDevice] = useState<string | null>(null);

  useEffect(() => {
    settingsGet()
      .then((settings) => {
        setCombo(settings.hotkey);
        setDevice(settings.input_device);
        setView(
          settings.onboarding_complete && settings.hotkey
            ? { kind: "home" }
            : { kind: "onboarding", step: "welcome" },
        );
      })
      .catch(() => setView({ kind: "onboarding", step: "welcome" }));
  }, []);

  if (view.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (view.kind === "home") {
    return (
      <Home
        combo={combo}
        onSetupAgain={() => setView({ kind: "onboarding", step: "permissions" })}
      />
    );
  }

  const go = (step: StepId) => setView({ kind: "onboarding", step });

  return (
    <div className="flex h-full flex-col">
      <StepTabs current={view.step} />

      <main className="min-h-0 flex-1 relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={view.step}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="absolute inset-0"
          >
            {view.step === "welcome" && <Welcome onNext={() => go("permissions")} />}

            {view.step === "permissions" && (
              <Permissions onBack={() => go("welcome")} onNext={() => go("hotkey")} />
            )}

            {view.step === "hotkey" && (
              <Hotkey
                initial={combo}
                onComboChange={setCombo}
                onBack={() => go("permissions")}
                onNext={() => go("microphone")}
              />
            )}

            {view.step === "microphone" && (
              <MicTest
                onBack={() => go("hotkey")}
                onNext={() => go("done")}
                onDeviceChange={setDevice}
              />
            )}

            {view.step === "done" && (
              <Done
                combo={combo}
                device={device}
                onBack={() => go("microphone")}
                onFinish={() => setView({ kind: "home" })}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}

/**
 * Post-setup surface. Deliberately thin — the hotkey is registered in Rust and works
 * everywhere, so the window's only job is to show that Pointy is live and listening.
 * The screen-help pipeline itself lands in Phase 1.
 */
function Home({ combo, onSetupAgain }: { combo: Combo | null; onSetupAgain: () => void }) {
  const { held } = useHotkeyPress(true);

  return (
    <div className="flex h-full flex-col items-center justify-center px-8">
      <div className="flex items-center gap-2.5">
        <PointyMark className="size-6" />
        <span className="text-[0.8125rem] font-semibold tracking-[0.22em] uppercase">Pointy</span>
      </div>

      <p className="mt-10 flex items-center gap-2.5 text-sm text-muted-foreground">
        <span
          className={
            held
              ? "size-2 rounded-full bg-signal"
              : "size-2 rounded-full bg-primary/70"
          }
        />
        {held ? "Listening…" : "Running in the background"}
      </p>

      <div className="mt-5 flex items-center gap-3">
        <span className="text-[0.9375rem] text-muted-foreground">Hold</span>
        {combo ? (
          <HotkeyCombo keys={combo.keys} size="sm" active={held} />
        ) : (
          <span className="text-[0.9375rem]">no hotkey set</span>
        )}
        <span className="text-[0.9375rem] text-muted-foreground">to ask about your screen</span>
      </div>

      <Button variant="ghost" size="sm" className="mt-10 text-muted-foreground" onClick={onSetupAgain}>
        Run setup again
      </Button>
    </div>
  );
}
