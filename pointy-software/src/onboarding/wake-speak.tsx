import { useEffect, useState } from "react";
import { Check, Circle } from "lucide-react";
import { motion } from "motion/react";

import { GuideArrow } from "@/components/guide-arrow";
import { HotkeyCombo } from "@/components/hotkey-combo";
import { MicShowcaseVisual } from "@/components/onboarding/mic-showcase-visual";
import { Card, CardQuestion, Screen } from "@/components/onboarding/screen";
import { StepNav } from "@/components/onboarding/step-nav";
import { Button } from "@/components/ui/button";
import { VoiceButton, type VoiceButtonState } from "@/components/ui/voice-button";
import { useHotkeyPress } from "@/hooks/use-hotkey";
import { useMicLevels } from "@/hooks/use-mic-levels";
import { permissionsRequest, permissionsStatus, settingsFinishOnboarding, type Combo } from "@/lib/pointy";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * Input level that reads as a voice rather than room noise. The bands come from
 * `audio.rs`, which already maps a −62 dB floor onto 0..1, so this is well clear of a
 * quiet room but reachable by anyone speaking normally.
 */
const HEARD_LEVEL = 0.08;

/**
 * Step 4 — hold the hotkey, speak, and watch the meter move.
 *
 * This step proves two things and nothing more: the hotkey fires, and the microphone
 * Pointy picked actually carries the user's voice. There is deliberately no transcript
 * here — a wrong or missing transcription tells the user nothing about whether their
 * microphone works, which is the only question this step exists to answer.
 */
export function WakeSpeak({
  combo,
  onBack,
  onFinish,
}: {
  combo: Combo;
  onBack: () => void;
  onFinish: () => void;
}) {
  const { held } = useHotkeyPress(true);
  // The microphone opens with the step, not with the hold. Opening a WASAPI stream
  // takes a moment, so starting it on key-down meant a short press showed flat bars and
  // no error — indistinguishable from "Pointy cannot hear you".
  const { bands, level, openedDevice, error: micError } = useMicLevels(true);

  const [busy, setBusy] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceButtonState>("idle");
  // One flag for the whole test: the hotkey went down *and* we picked up a voice while
  // it was held. Tracking it only during the hold is what makes it a real check — the
  // meter runs the whole time this step is open, so background noise alone must not
  // count as a pass.
  const [heard, setHeard] = useState(false);

  const detected = Boolean(openedDevice) && !micError;
  const ready = detected && heard;

  useEffect(() => {
    if (held && level >= HEARD_LEVEL) setHeard(true);
  }, [held, level]);

  useEffect(() => {
    if (held) setVoiceState("recording");
    else if (heard) setVoiceState("success");
    else setVoiceState("idle");
  }, [held, heard]);

  useEffect(() => {
    void permissionsStatus().then((statuses) => {
      const mic = statuses.find((entry) => entry.id === "microphone");
      if (mic?.state !== "granted") void permissionsRequest("microphone");
    });
  }, []);

  const finish = async () => {
    setBusy(true);
    setFinishError(null);
    try {
      await settingsFinishOnboarding();
      onFinish();
    } catch {
      setFinishError("Couldn’t finish setup. Try again.");
      setBusy(false);
    }
  };

  return (
    <Screen
      title="Wake Pointy and speak"
      lede="Hold your hotkey and say something out loud. When the meter moves with your voice, Pointy can hear you."
    >
      <div className="flex flex-col gap-4">
        <Card className="p-5">
          <CardQuestion>
            <span className="inline-flex flex-wrap items-center gap-2">
              Hold
              <HotkeyCombo keys={combo.keys} active={held} />
              to wake Pointy
            </span>
          </CardQuestion>

          <div className="relative mt-5 flex justify-center py-2">
            <GuideArrow visible={held} />
            <VoiceButton
              state={voiceState}
              size="default"
              label={held ? "Listening…" : heard ? "Heard you" : "Ask Pointy"}
              trailing={<HotkeyCombo keys={combo.keys} size="xs" active={held} />}
              className="pointer-events-none h-11 rounded-lg bg-card px-4"
            />
          </div>

          <p className="mt-3 text-center text-xs text-muted-foreground">
            {held
              ? "Keep holding — speak clearly, then release."
              : "Press and hold your hotkey now."}
          </p>
          {!isTauri() && (
            <p className="mt-2 text-center text-xs text-muted-foreground/80">
              In preview: hold the Space bar to simulate your hotkey.
            </p>
          )}
        </Card>

        <MicShowcaseVisual level={level} bands={bands} heard={held || heard} error={micError} />

        <Card className="p-5">
          <div className="flex flex-col gap-3">
            <Checkline done={detected}>
              {micError
                ? micError
                : openedDevice
                  ? `Microphone detected — ${openedDevice}`
                  : "Looking for your microphone…"}
            </Checkline>
            <Checkline done={heard}>
              {heard ? "Pointy heard your voice" : "Hold your hotkey and speak to test it"}
            </Checkline>
          </div>

          {heard && !held && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setHeard(false)}
              >
                Test again
              </Button>
            </div>
          )}
        </Card>

        {finishError && (
          <p className="text-center text-sm text-muted-foreground" role="status">
            {finishError}
          </p>
        )}
      </div>

      <StepNav
        onBack={onBack}
        onNext={() => void finish()}
        nextDisabled={!detected || busy}
        nextLabel={busy ? "Finishing…" : heard ? "Start using Pointy" : "Skip voice test"}
      />
      <p className="mx-auto mt-3 max-w-md text-center text-xs text-muted-foreground">
        {heard
          ? "Your microphone is working — you’re ready to go."
          : "Hold your hotkey and speak to check your microphone, or skip if you're sure it works."}
      </p>
    </Screen>
  );
}

/** One line of the microphone check: a filled tick once it passes, a hollow ring until. */
function Checkline({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full",
          done ? "bg-forest text-white" : "text-muted-foreground/50",
        )}
      >
        {done ? (
          <motion.span initial={{ scale: 0.4 }} animate={{ scale: 1 }}>
            <Check className="size-3" strokeWidth={3} aria-hidden />
          </motion.span>
        ) : (
          <Circle className="size-3.5" aria-hidden />
        )}
      </span>
      <span className={cn("text-sm", done ? "text-foreground" : "text-muted-foreground")}>
        {children}
      </span>
    </div>
  );
}
