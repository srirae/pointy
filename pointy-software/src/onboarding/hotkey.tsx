import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { motion } from "motion/react";

import { GuideArrow } from "@/components/guide-arrow";
import { HotkeyCombo } from "@/components/hotkey-combo";
import { Card, CardQuestion, Screen, Stage } from "@/components/onboarding/screen";
import { Button } from "@/components/ui/button";
import { VoiceButton, type VoiceButtonState } from "@/components/ui/voice-button";
import { useHotkeyCapture, useHotkeyPress } from "@/hooks/use-hotkey";
import { hotkeySave, type Combo } from "@/lib/pointy";

type Phase = "record" | "test";

export function Hotkey({
  onBack,
  onNext,
  initial,
  onComboChange,
}: {
  onBack: () => void;
  onNext: () => void;
  initial: Combo | null;
  onComboChange: (combo: Combo) => void;
}) {
  const [phase, setPhase] = useState<Phase>("record");
  const [combo, setCombo] = useState<Combo | null>(initial);

  if (phase === "record") {
    return (
      <RecordPhase
        onBack={onBack}
        existing={combo}
        onSaved={(saved) => {
          setCombo(saved);
          onComboChange(saved);
          setPhase("test");
        }}
      />
    );
  }

  return (
    <TestPhase
      combo={combo!}
      onBack={() => setPhase("record")}
      onNext={onNext}
    />
  );
}

function RecordPhase({
  onBack,
  existing,
  onSaved,
}: {
  onBack: () => void;
  existing: Combo | null;
  onSaved: (combo: Combo) => void;
}) {
  const { recording, pressed, validation, captured, hookError, start, cancel } =
    useHotkeyCapture();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Land on this screen already listening — the fastest path is to just press the keys.
  useEffect(() => {
    void start();
    return () => void cancel();
  }, [start, cancel]);

  const shown = captured?.keys ?? (pressed.length > 0 ? pressed : existing?.keys ?? []);
  const invalidReason = !captured && pressed.length > 0 ? validation?.reason : null;

  const save = async () => {
    const keys = captured?.keys ?? existing?.keys;
    if (!keys) return;
    setSaving(true);
    setSaveError(null);
    try {
      onSaved(await hotkeySave(keys));
    } catch (reason) {
      setSaveError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      title="Record your hotkey"
      lede="Hold the keys you want to use, then let go. Whatever you press becomes your combo — hold it to ask, release it to send."
      onBack={onBack}
    >
      <Card>
        <CardQuestion>
          {captured
            ? "Happy with this combo?"
            : recording
              ? "Press and hold your keys now"
              : "Ready when you are"}
        </CardQuestion>

        <Stage className="min-h-[9.5rem] relative overflow-hidden group">
          {recording && !captured && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.6 }}
              exit={{ opacity: 0 }}
              transition={{ repeat: Infinity, duration: 2.5, repeatType: "reverse", ease: "easeInOut" }}
              className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-accent/5 via-transparent to-accent/10"
            />
          )}
          
          {shown.length > 0 ? (
            <div className="relative z-10">
              <HotkeyCombo keys={shown} size="lg" active={recording && !captured} />
            </div>
          ) : (
            <motion.div 
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 0.45, y: 0 }}
              className="relative z-10 flex flex-col items-center gap-5 grayscale contrast-50"
            >
              <HotkeyCombo keys={["Ctrl", "Space"]} size="lg" />
              <span className="text-[0.65rem] font-semibold tracking-[0.2em] uppercase text-muted-foreground">
                {recording ? "Listening..." : "Press your keys"}
              </span>
            </motion.div>
          )}
        </Stage>

        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          At least one modifier — Ctrl, Alt, Shift or Win — and up to three keys. Two modifiers
          on their own work well, like Ctrl + Win.
        </p>

        {invalidReason && (
          <p className="mt-2 text-sm font-medium text-destructive">{invalidReason}</p>
        )}
        {hookError && (
          <p className="mt-2 text-sm text-destructive">
            Pointy could not read the keyboard: {hookError}
          </p>
        )}
        {saveError && <p className="mt-2 text-sm text-destructive">{saveError}</p>}

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button variant="ghost" size="sm" onClick={() => void start()}>
            {recording ? "Start over" : "Record again"}
          </Button>
          <Button disabled={!captured || saving} onClick={() => void save()}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Continue
          </Button>
        </div>
      </Card>
    </Screen>
  );
}

function TestPhase({
  combo,
  onBack,
  onNext,
}: {
  combo: Combo;
  onBack: () => void;
  onNext: () => void;
}) {
  const { held, pressCount } = useHotkeyPress(true);
  const [state, setState] = useState<VoiceButtonState>("idle");
  const [passed, setPassed] = useState(false);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    return () => timers.current.forEach((id) => window.clearTimeout(id));
  }, []);

  // Key-down: the button starts recording, exactly as it will when a real question is
  // being asked. Key-up runs the same processing → success transition.
  useEffect(() => {
    if (!held) return;
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    setState("recording");
  }, [held]);

  useEffect(() => {
    if (pressCount === 0) return;
    setState("processing");
    setPassed(true);
    timers.current.push(
      window.setTimeout(() => setState("success"), 650),
      window.setTimeout(() => setState("idle"), 2300),
    );
  }, [pressCount]);

  return (
    <Screen
      title="Test your hotkey"
      lede="Press and hold it now."
      onBack={onBack}
      footnote={
        passed
          ? "This is the real interaction. In the app, that same press sends your question with a screenshot — and the dot lands on the answer."
          : undefined
      }
    >
      <Card>
        <CardQuestion>
          <span className="inline-flex flex-wrap items-center gap-2">
            Hold
            <HotkeyCombo keys={combo.keys} />
            and watch the button
          </span>
        </CardQuestion>

        <Stage className="min-h-[9.5rem] overflow-visible">
          <div className="relative">
            <GuideArrow visible={held} />
            <VoiceButton
              state={state}
              size="default"
              label="Ask Pointy"
              trailing={<HotkeyCombo keys={combo.keys} size="xs" />}
              className="pointer-events-none h-11 rounded-lg bg-card px-4"
            />
          </div>
        </Stage>

        <div className="mt-6 flex items-center justify-between gap-4">
          <span className="text-xs text-muted-foreground">
            {passed
              ? "Hotkey works."
              : held
                ? "Listening — let go when you are done."
                : "Waiting for your hotkey…"}
          </span>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onBack}>
              Change hotkey
            </Button>
            <Button disabled={!passed} onClick={onNext}>
              Continue
            </Button>
          </div>
        </div>
      </Card>
    </Screen>
  );
}
