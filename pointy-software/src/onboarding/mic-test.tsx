import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { AgentAudioVisualizerBar } from "@/components/agent-audio-visualizer-bar";
import { Card, CardQuestion, Screen, Stage } from "@/components/onboarding/screen";
import { Button } from "@/components/ui/button";
import { useMicLevels } from "@/hooks/use-mic-levels";
import { audioInputDevices, type AudioDevice } from "@/lib/pointy";
import { cn } from "@/lib/utils";

/** Below this the input is indistinguishable from a muted microphone. */
const HEARD_THRESHOLD = 0.12;

export function MicTest({
  onBack,
  onNext,
  onDeviceChange,
}: {
  onBack: () => void;
  onNext: () => void;
  onDeviceChange: (device: string) => void;
}) {
  const [device, setDevice] = useState<string | null>(null);
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [picking, setPicking] = useState(false);
  const [struggling, setStruggling] = useState(false);

  const { bands, peak, openedDevice, error } = useMicLevels(true, device);

  useEffect(() => {
    if (openedDevice) onDeviceChange(openedDevice);
  }, [openedDevice, onDeviceChange]);

  useEffect(() => {
    audioInputDevices().then(setDevices).catch(() => setDevices([]));
  }, []);

  const heard = peak >= HEARD_THRESHOLD;

  // Offer help on its own if the microphone stays silent — the user should not have to
  // work out that something is wrong.
  useEffect(() => {
    if (!openedDevice || heard) {
      setStruggling(false);
      return;
    }
    const timer = window.setTimeout(() => setStruggling(true), 6000);
    return () => window.clearTimeout(timer);
  }, [openedDevice, heard]);

  return (
    <Screen
      title="Test your microphone"
      lede="Built-in or wired microphones are the most reliable. Bluetooth headsets add lag between your question and the answer."
      onBack={onBack}
    >
      <Card>
        <CardQuestion>Do you see the bars move when you speak?</CardQuestion>

        <Stage className="min-h-[10rem]">
          <AgentAudioVisualizerBar
            state="speaking"
            size="md"
            barCount={bands.length}
            volumeBands={bands}
            color="#0D4A47"
            className="h-24 w-full max-w-sm"
          />
        </Stage>

        <div className="mt-4 flex items-center justify-between gap-4 text-xs">
          <span className="text-muted-foreground">
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : openedDevice ? (
              <>
                Listening on <span className="text-foreground">{openedDevice}</span>
              </>
            ) : (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" />
                Opening the microphone…
              </span>
            )}
          </span>
          {heard && (
            <span className="inline-flex items-center gap-1.5 text-primary">
              <Check className="size-3.5" aria-hidden />
              Input detected
            </span>
          )}
        </div>

        {struggling && (
          <p className="mt-4 rounded-lg bg-secondary/70 p-4 text-xs leading-relaxed text-muted-foreground">
            Check the microphone is not muted in hardware, close any app that has it open
            exclusively, then pick a different input below. Pointy needs to hear you clearly
            enough to transcribe on-device.
          </p>
        )}

        {picking && (
          <ul className="mt-4 divide-y divide-border/70 overflow-hidden rounded-lg border border-border/70">
            {devices.map((entry) => {
              const selected = (openedDevice ?? device) === entry.name;
              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    onClick={() => {
                      setDevice(entry.name);
                      setPicking(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm transition-colors",
                      selected ? "bg-primary/5 text-foreground" : "hover:bg-secondary/60",
                    )}
                  >
                    <span className="truncate">
                      {entry.name}
                      {entry.is_default && (
                        <span className="ml-2 text-xs text-muted-foreground">system default</span>
                      )}
                    </span>
                    {selected && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
                  </button>
                </li>
              );
            })}
            {devices.length === 0 && (
              <li className="px-4 py-3 text-sm text-muted-foreground">No input devices found.</li>
            )}
          </ul>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={() => setPicking((open) => !open)}>
            Change microphone
          </Button>
          <Button onClick={onNext}>Yes</Button>
        </div>
      </Card>
    </Screen>
  );
}
