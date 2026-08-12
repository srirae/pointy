import { useState } from "react";
import { Loader2 } from "lucide-react";

import { HotkeyCombo } from "@/components/hotkey-combo";
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
      title="Pointy is ready"
      lede="It sits in the background from here. Hold your hotkey whenever you are stuck and ask out loud."
      onBack={onBack}
      footnote="Pointy takes a screenshot only at the moment you ask, and drops it once you have the answer."
    >
      <Card className="p-0">
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
          <Row label="Access">
            <span className="text-sm">Microphone, screen and accessibility granted</span>
          </Row>
        </dl>

        <div className="flex items-center justify-end gap-3 border-t border-border/70 px-6 py-4">
          <Button disabled={busy} onClick={() => void finish()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Start using Pointy
          </Button>
        </div>
      </Card>

      {error && <p className="mt-4 text-center text-sm text-destructive">{error}</p>}
    </Screen>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border/70 px-6 py-5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center">{children}</dd>
    </div>
  );
}
