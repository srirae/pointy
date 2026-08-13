import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { motion } from "motion/react";

import { HotkeyCombo } from "@/components/hotkey-combo";
import { PointyMark } from "@/components/pointy-mark";
import { Card, Screen } from "@/components/onboarding/screen";
import { Button } from "@/components/ui/button";
import { settingsFinishOnboarding, type Combo } from "@/lib/pointy";

export function Done({
  combo,
  device,
  onBack,
  onFinish,
}: {
  combo: Combo | null;
  device: string | null;
  onBack: () => void;
  onFinish: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    setBusy(true);
    try {
      await settingsFinishOnboarding();
      onFinish();
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  };

  return (
    <Screen
      title="You’re ready"
      lede="Pointy sits in the background from here. Hold your hotkey whenever you’re stuck and ask out loud."
      onBack={onBack}
      progressHint="Last step"
      footnote="Pointy takes a screenshot only at the moment you ask, and drops it once you have the answer."
    >
      <Card className="overflow-hidden p-0">
        <div className="relative border-b border-border/60 bg-gradient-to-br from-forest/[0.07] via-card to-ochre/[0.08] px-6 py-8">
          <motion.div
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 400, damping: 22 }}
            className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-card shadow-[0_12px_32px_-16px_rgba(13,74,71,0.45)] ring-1 ring-border/50"
          >
            <PointyMark className="size-8" />
          </motion.div>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            Hold to ask · release to send · watch the dot land
          </p>
        </div>

        <dl>
          <Row label="Your hotkey">
            {combo ? (
              <HotkeyCombo keys={combo.keys} />
            ) : (
              <span className="text-sm text-muted-foreground">Not set</span>
            )}
          </Row>
          <Row label="Microphone">
            <span className="truncate text-sm">{device ?? "System default"}</span>
          </Row>
          <Row label="Access" last>
            <span className="inline-flex items-center gap-1.5 text-sm">
              <Check className="size-3.5 text-forest" aria-hidden />
              Mic, screen & accessibility
            </span>
          </Row>
        </dl>

        <div className="flex items-center justify-end gap-3 border-t border-border/60 px-6 py-4">
          <Button
            disabled={busy}
            onClick={() => void finish()}
            className="h-11 rounded-xl px-7 shadow-[0_12px_28px_-16px_rgba(13,74,71,0.65)]"
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Start using Pointy
          </Button>
        </div>
      </Card>

      {error && <p className="mt-4 text-center text-sm text-destructive">{error}</p>}
    </Screen>
  );
}

function Row({
  label,
  children,
  last,
}: {
  label: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={
        last
          ? "flex items-center justify-between gap-6 px-6 py-5"
          : "flex items-center justify-between gap-6 border-b border-border/60 px-6 py-5"
      }
    >
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center">{children}</dd>
    </div>
  );
}
