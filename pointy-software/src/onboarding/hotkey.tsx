import { useEffect, useRef, useState } from "react";

import { motion } from "motion/react";



import { HotkeyCombo } from "@/components/hotkey-combo";

import { Card, CardQuestion, Screen, Stage } from "@/components/onboarding/screen";

import { StepNav } from "@/components/onboarding/step-nav";

import { Button } from "@/components/ui/button";

import { useHotkeyCapture } from "@/hooks/use-hotkey";

import { progressLabel } from "@/lib/onboarding-flow";

import { hotkeySave, type Combo } from "@/lib/pointy";



/** Step 3 — record the push-to-talk hotkey, then continue to the live speak test. */

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

  const [saving, setSaving] = useState(false);

  const [saveError, setSaveError] = useState<string | null>(null);

  const savedRef = useRef(false);



  useEffect(() => {

    if (!ready) return;

    void start();

    return () => void cancel();

  }, [ready, start, cancel]);



  const shown = captured?.keys ?? pressed;

  const showingHint = shown.length === 0;

  const invalidReason = !captured && pressed.length > 0 ? validation?.reason : null;



  const useSuggested = () => setCaptured({ keys: ["Ctrl", "Space"] });



  const save = async (keys = captured?.keys ?? initial?.keys) => {

    if (!keys || savedRef.current) return false;

    setSaving(true);

    setSaveError(null);

    try {

      const saved = await hotkeySave(keys);

      onComboChange(saved);

      savedRef.current = true;

      onNext();

      return true;

    } catch (reason) {

      setSaveError(String(reason));

      setSaving(false);

      return false;

    }

  };



  const continueForward = () => {

    if (captured) void save(captured.keys);

    else if (initial) onNext();

    else void save(["Ctrl", "Space"]);

  };



  return (

    <Screen

      title="Choose how you’ll wake Pointy"

      lede="Hold the keys you want, then let go. This is the gesture that opens the glass panel."

      progressHint={progressLabel("hotkey")}

    >

      <Card>

        <CardQuestion>

          {!ready

            ? "Getting the keyboard ready…"

            : captured

              ? "Happy with this combo?"

              : recording

                ? "Press and hold your keys now"

                : "Ready when you are"}

        </CardQuestion>



        <Stage className="relative min-h-[9.5rem] overflow-hidden group">

          {recording && !captured && ready && (

            <motion.div

              initial={{ opacity: 0 }}

              animate={{ opacity: 0.6 }}

              exit={{ opacity: 0 }}

              transition={{ repeat: Infinity, duration: 2.5, repeatType: "reverse", ease: "easeInOut" }}

              className="pointer-events-none absolute inset-0 bg-gradient-to-tr from-accent/5 via-transparent to-accent/10"

            />

          )}



          {showingHint ? (

            <motion.div

              initial={{ opacity: 0, y: 5 }}

              animate={{ opacity: 0.45, y: 0 }}

              className="relative z-10 flex flex-col items-center gap-5 grayscale contrast-50"

            >

              <HotkeyCombo keys={["Ctrl", "Space"]} size="lg" />

              <span className="text-[0.65rem] font-semibold tracking-[0.2em] uppercase text-muted-foreground">

                {!ready ? "Starting…" : recording ? "Listening…" : "Press your keys"}

              </span>

            </motion.div>

          ) : (

            <div className="relative z-10">

              <HotkeyCombo keys={shown} size="lg" active={recording && !captured} />

              {recording && !captured && (

                <p className="mt-4 text-center text-[0.65rem] font-semibold tracking-[0.18em] uppercase text-muted-foreground">

                  Release to save this combo

                </p>

              )}

            </div>

          )}

        </Stage>



        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">

          At least one modifier — Ctrl, Alt, Shift or Win — and up to three keys.

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



        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">

          <Button

            variant="secondary"

            size="sm"

            className="rounded-lg"

            disabled={!ready || saving}

            onClick={useSuggested}

          >

            Use Ctrl + Space

          </Button>

          <Button variant="ghost" size="sm" disabled={!ready} onClick={() => void start()}>

            {recording ? "Start over" : "Record again"}

          </Button>

        </div>

      </Card>



      <StepNav

        onBack={onBack}

        onNext={continueForward}

        nextDisabled={saving || (!captured && !initial)}

        nextLabel={saving ? "Saving…" : "Continue"}

      />

    </Screen>

  );

}


