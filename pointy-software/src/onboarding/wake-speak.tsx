import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { GuideArrow } from "@/components/guide-arrow";
import { HotkeyCombo } from "@/components/hotkey-combo";
import { MicShowcaseVisual } from "@/components/onboarding/mic-showcase-visual";
import { Card, CardQuestion, Screen } from "@/components/onboarding/screen";
import { StepNav } from "@/components/onboarding/step-nav";
import { Button } from "@/components/ui/button";
import { VoiceButton, type VoiceButtonState } from "@/components/ui/voice-button";
import { useHotkeyPress } from "@/hooks/use-hotkey";
import { useMicLevels } from "@/hooks/use-mic-levels";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { progressLabel } from "@/lib/onboarding-flow";
import { permissionsRequest, permissionsStatus, settingsFinishOnboarding, type Combo } from "@/lib/pointy";
import { cn } from "@/lib/utils";

const MIN_WORDS = 2;

/** Step 4 — hold hotkey to wake Pointy, speak, read live transcription, finish setup. */
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
  const { bands, level, peak } = useMicLevels(held);
  const { display, wordCount, error: speechError, supported, reset } =
    useSpeechRecognition(held);

  const [busy, setBusy] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceButtonState>("idle");

  useEffect(() => {
    if (held) setVoiceState("recording");
    else if (wordCount >= MIN_WORDS) setVoiceState("success");
    else setVoiceState("idle");
  }, [held, wordCount]);

  useEffect(() => {
    void permissionsStatus().then((statuses) => {
      const mic = statuses.find((entry) => entry.id === "microphone");
      if (mic?.state !== "granted") void permissionsRequest("microphone");
    });
  }, []);

  const heard = peak >= 0.08 || wordCount >= MIN_WORDS;
  const ready = wordCount >= MIN_WORDS;

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
      title="Wake the glass panel and speak"
      lede="Hold your hotkey — the glass panel opens. Say something out loud and check the transcript matches what you meant."
      progressHint={progressLabel("speak")}
      wide
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
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
                label={held ? "Listening…" : display ? "Heard you" : "Ask Pointy"}
                trailing={<HotkeyCombo keys={combo.keys} size="xs" active={held} />}
                className="pointer-events-none h-11 rounded-lg bg-card px-4"
              />
            </div>

            <p className="mt-3 text-center text-xs text-muted-foreground">
              {held
                ? "Keep holding — speak clearly, then release."
                : "Press and hold your hotkey now."}
            </p>
          </Card>

          <MicShowcaseVisual level={level} bands={bands} heard={held || heard} />
        </div>

        <div className="flex flex-col gap-4">
          <Card className="flex min-h-[18rem] flex-col p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Live transcript
              </p>
              {wordCount > 0 && (
                <span className="text-[0.6875rem] text-muted-foreground">{wordCount} words</span>
              )}
            </div>

            <div
              className={cn(
                "mt-4 flex-1 rounded-xl border px-4 py-4",
                held ? "border-signal/35 bg-signal/[0.06]" : "border-border/60 bg-secondary/40",
              )}
            >
              <AnimatePresence mode="wait">
                {display ? (
                  <motion.p
                    key={display}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="font-serif text-[1.25rem] leading-relaxed tracking-tight text-foreground"
                  >
                    {display}
                    {held && (
                      <motion.span
                        animate={{ opacity: [1, 0.2, 1] }}
                        transition={{ duration: 0.9, repeat: Infinity }}
                        className="ml-0.5 inline-block text-signal"
                      >
                        |
                      </motion.span>
                    )}
                  </motion.p>
                ) : (
                  <motion.p
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-sm leading-relaxed text-muted-foreground"
                  >
                    Hold your hotkey and say: “Where do I click?” or anything you like.
                  </motion.p>
                )}
              </AnimatePresence>
            </div>

            {!supported && (
              <p className="mt-3 text-xs text-muted-foreground">
                Transcript preview unavailable here — watch the orb react to your voice instead.
              </p>
            )}
            {speechError && <p className="mt-3 text-xs text-destructive">{speechError}</p>}

            {ready && !held && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-3 text-xs font-medium text-forest"
              >
                Transcript looks good — Pointy heard you clearly.
              </motion.p>
            )}
          </Card>

          <div className="flex justify-center">
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={reset}>
              Clear & try again
            </Button>
          </div>
          {finishError && (
            <p className="text-center text-sm text-muted-foreground" role="status">
              {finishError}
            </p>
          )}
        </div>
      </div>

      <StepNav
        onBack={onBack}
        onNext={() => void finish()}
        nextDisabled={!ready || busy}
        nextLabel={busy ? "Finishing…" : "Start using Pointy"}
      />
      <p className="mx-auto mt-3 max-w-md text-center text-xs text-muted-foreground">
        {ready
          ? "Finish when the text matches what you said."
          : `Hold your hotkey and say at least ${MIN_WORDS} words.`}
      </p>
    </Screen>
  );
}
