import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Mic } from "lucide-react";

import { HotkeyCaptureInput } from "@/components/onboarding/hotkey-capture-input";
import { Card, CardQuestion, Screen } from "@/components/onboarding/screen";
import { StepNav } from "@/components/onboarding/step-nav";
import { Button } from "@/components/ui/button";
import { useHotkeyCapture } from "@/hooks/use-hotkey";
import { progressLabel } from "@/lib/onboarding-flow";
import { requestMicrophoneAccess } from "@/lib/microphone";
import { hotkeyCurrent, registerAndSaveHotkey, type Combo } from "@/lib/pointy";

/**
 * Hotkey + microphone gate. Continue stays disabled until a combo is registered
 * AND the microphone has been granted.
 */
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
  const { ready, recording, pressed, validation, captured, hookError, start, cancel, setCaptured } =
    useHotkeyCapture();

  const [registering, setRegistering] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [justEnabled, setJustEnabled] = useState(false);
  const [micGranted, setMicGranted] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const lastRegisteredKeys = useRef<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    void start();
    return () => void cancel();
  }, [ready, start, cancel]);

  useEffect(() => {
    if (!initial?.keys.length) return;
    void hotkeyCurrent().then((current) => {
      if (current?.keys.join("+") === initial.keys.join("+")) {
        lastRegisteredKeys.current = initial.keys.join("+");
        setRegistered(true);
      }
    });
  }, [initial]);

  const shown = captured?.keys ?? pressed;
  const invalidReason = !captured && pressed.length > 0 ? validation?.reason : null;
  const canContinue = registered && micGranted && !registering && !micBusy;

  const registerCombo = async (keys: string[]) => {
    const id = keys.join("+");
    if (lastRegisteredKeys.current === id && registered) return;

    setRegistering(true);
    setRegisterError(null);
    setRegistered(false);
    setJustEnabled(false);

    try {
      const saved = await registerAndSaveHotkey(keys);
      onComboChange(saved);
      lastRegisteredKeys.current = id;
      setRegistered(true);
    } catch (reason) {
      setRegisterError(String(reason));
      lastRegisteredKeys.current = null;
    } finally {
      setRegistering(false);
    }
  };

  useEffect(() => {
    if (!captured?.keys.length) return;
    void registerCombo(captured.keys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captured]);

  const askMic = async () => {
    setMicBusy(true);
    setMicError(null);
    const result = await requestMicrophoneAccess();
    setMicGranted(result.granted);
    setMicError(result.error);
    setMicBusy(false);
  };

  useEffect(() => {
    void askMic();
  }, []);

  useEffect(() => {
    if (canContinue) setJustEnabled(true);
  }, [canContinue]);

  const recordAgain = () => {
    setRegistered(false);
    setJustEnabled(false);
    setRegisterError(null);
    lastRegisteredKeys.current = null;
    void start();
  };

  return (
    <Screen
      title="Set your wake hotkey"
      lede="Hold any key combination you want, then let go. Pointy will wake whenever you hold those keys — anywhere on your desktop."
      progressHint={progressLabel("hotkey")}
    >
      <Card>
        <CardQuestion>
          {!ready
            ? "Getting the keyboard ready…"
            : registered
              ? "Hotkey registered on your system"
              : registering
                ? "Registering your hotkey…"
                : "Press your key combination below"}
        </CardQuestion>

        <div className="mt-5 space-y-3">
          <HotkeyCaptureInput
            keys={shown}
            listening={recording && !captured && ready}
            ready={ready}
          />

          <AnimatePresence>
            {registered && (
              <motion.p
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center justify-center gap-2 text-sm font-medium text-forest"
              >
                <Check className="size-4" aria-hidden />
                Hotkey saved
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Hold any combo — for example Ctrl + Shift + Space — then release to save it.
        </p>

        {invalidReason && (
          <p className="mt-2 text-sm font-medium text-destructive">{invalidReason}</p>
        )}
        {hookError && (
          <p className="mt-2 text-sm text-destructive">
            Pointy could not read the keyboard: {hookError}
          </p>
        )}
        {registerError && <p className="mt-2 text-sm text-destructive">{registerError}</p>}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            className="rounded-lg"
            disabled={!ready || registering}
            onClick={() => setCaptured({ keys: ["Ctrl", "Shift", "Space"] })}
          >
            Use Ctrl + Shift + Space
          </Button>
          <Button variant="ghost" size="sm" disabled={!ready || registering} onClick={recordAgain}>
            Record again
          </Button>
        </div>
      </Card>

      <Card className="mt-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardQuestion>
              <span className="inline-flex items-center gap-2">
                <Mic className="size-4" aria-hidden />
                Microphone
              </span>
            </CardQuestion>
            <p className="mt-2 text-sm text-muted-foreground">
              {micGranted
                ? "Microphone is allowed. Next you’ll hold the hotkey and speak."
                : "Pointy needs the mic to hear you when the hotkey wakes it."}
            </p>
            {micError && !micGranted && (
              <p className="mt-2 text-sm text-destructive">{micError}</p>
            )}
          </div>
          {micGranted ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-forest">
              <Check className="size-4" aria-hidden />
              Allowed
            </span>
          ) : (
            <Button size="sm" className="rounded-lg" disabled={micBusy} onClick={() => void askMic()}>
              {micBusy ? "Asking…" : "Allow microphone"}
            </Button>
          )}
        </div>
      </Card>

      <StepNav
        onBack={onBack}
        onNext={onNext}
        nextDisabled={!canContinue}
        nextReady={justEnabled && canContinue}
        nextLabel={
          !registered ? "Register a hotkey first" : !micGranted ? "Allow the microphone" : "Continue"
        }
      />
    </Screen>
  );
}
