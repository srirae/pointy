import { useEffect, useState } from "react";
import { Keyboard, Mic, RotateCcw } from "lucide-react";
import { motion } from "motion/react";

import { VoiceLanguages } from "@/components/dashboard/voice-languages";
import { HotkeyCombo } from "@/components/hotkey-combo";
import { Atmosphere } from "@/components/onboarding/atmosphere";
import { HotkeyCaptureInput } from "@/components/onboarding/hotkey-capture-input";
import { MicShowcaseVisual } from "@/components/onboarding/mic-showcase-visual";
import { PointyMark } from "@/components/pointy-mark";
import { Button } from "@/components/ui/button";
import { useHotkeyCapture, useHotkeyPress } from "@/hooks/use-hotkey";
import { useMicLevels } from "@/hooks/use-mic-levels";
import {
  overlaySetEnabled,
  overlayWake,
  overlayRest,
  registerAndSaveHotkey,
  type Combo,
} from "@/lib/pointy";

const HEARD_LEVEL = 0.08;

/** Post-setup home — change the hotkey, confirm wake, watch the mic. */
export function Dashboard({
  combo,
  onComboChange,
  onSetupAgain,
}: {
  combo: Combo | null;
  onComboChange: (combo: Combo) => void;
  onSetupAgain: () => void;
}) {
  const { held } = useHotkeyPress(true);
  const { bands, level, error: micError } = useMicLevels(true, null, true);
  const [heard, setHeard] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (held && level >= HEARD_LEVEL) setHeard(true);
  }, [held, level]);

  useEffect(() => {
    if (held) void overlayWake();
    else void overlayRest();
  }, [held]);

  return (
    <div className="relative flex h-full flex-col overflow-y-auto">
      <Atmosphere />

      <header className="relative z-10 flex items-center justify-between px-8 py-5">
        <div className="flex items-center gap-2.5">
          <PointyMark className="size-5" />
          <span className="text-[0.75rem] font-semibold tracking-[0.2em] uppercase">Pointy</span>
        </div>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={onSetupAgain}>
          <RotateCcw className="size-3.5" aria-hidden />
          Run setup again
        </Button>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-2xl flex-1 flex-col px-8 pb-12">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center text-center"
        >
          <div className="flex size-14 items-center justify-center rounded-2xl bg-card shadow-[0_16px_40px_-20px_rgba(13,74,71,0.4)] ring-1 ring-border/50">
            <PointyMark className="size-8" />
          </div>
          <h1 className="mt-6 text-[1.875rem] font-bold leading-tight tracking-[-0.035em]">
            You’re all set
          </h1>
          <p className="mt-3 max-w-md text-[0.975rem] leading-relaxed text-muted-foreground">
            Hold your hotkey anywhere — a frosted overlay wakes, the guide-dot listens, and
            Pointy captures what’s on screen. Change the shortcut here anytime.
          </p>
        </motion.div>

        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.06 }}
          className="mt-8 rounded-2xl border border-border/60 bg-card/90 p-6 shadow-[0_22px_48px_-28px_rgba(46,58,71,0.28)]"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Keyboard className="size-3.5" aria-hidden />
              Wake hotkey
            </div>
            {!editing && (
              <Button variant="secondary" size="sm" className="rounded-lg" onClick={() => setEditing(true)}>
                Change hotkey
              </Button>
            )}
          </div>

          {editing ? (
            <HotkeyEditor
              onSaved={(next) => {
                onComboChange(next);
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div
              className={`mt-5 flex flex-wrap items-center justify-center gap-2.5 rounded-xl border px-5 py-4 transition-colors ${
                held ? "border-forest/40 bg-forest/[0.06]" : "border-border/60 bg-secondary/40"
              }`}
            >
              <span className="text-sm text-muted-foreground">Hold</span>
              {combo ? (
                <HotkeyCombo keys={combo.keys} size="sm" active={held} />
              ) : (
                <span className="text-sm font-medium">your hotkey</span>
              )}
              <span className="text-sm text-muted-foreground">to wake Pointy</span>
            </div>
          )}
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.12 }}
          className="mt-5 overflow-hidden rounded-2xl border border-border/60"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border/50 bg-card/80 px-6 py-3">
            <div className="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <Mic className="size-3.5" aria-hidden />
              Microphone
            </div>
            <span className="text-xs text-muted-foreground">
              {held ? "Listening…" : heard ? "Heard you" : "Hold your hotkey and speak"}
            </span>
          </div>
          <MicShowcaseVisual
            level={held ? level : 0}
            bands={held ? bands : []}
            heard={held || heard}
            error={held ? micError : null}
          />
        </motion.section>

        <VoiceLanguages />
      </main>
    </div>
  );
}

function HotkeyEditor({
  onSaved,
  onCancel,
}: {
  onSaved: (combo: Combo) => void;
  onCancel: () => void;
}) {
  const { ready, recording, pressed, captured, hookError, start, cancel, setCaptured } =
    useHotkeyCapture();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void overlaySetEnabled(false);
    if (ready) void start();
    return () => {
      void cancel();
      void overlaySetEnabled(true);
    };
  }, [ready, start, cancel]);

  const shown = captured?.keys ?? pressed;

  const save = async (keys: string[]) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await registerAndSaveHotkey(keys);
      onSaved(saved);
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  };

  useEffect(() => {
    if (captured?.keys.length) void save(captured.keys);
  }, [captured]);

  return (
    <div className="mt-5 space-y-4">
      <HotkeyCaptureInput keys={shown} listening={recording && !captured && ready} ready={ready} />
      {hookError && <p className="text-sm text-destructive">{hookError}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={!ready || saving}
          onClick={() => setCaptured({ keys: ["Ctrl", "Shift", "Space"] })}
        >
          Use Ctrl + Shift + Space
        </Button>
        <Button variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
