import { useCallback, useEffect, useState } from "react";
import { Check, Crosshair, Loader2, Mic, Monitor, RotateCw, X } from "lucide-react";

import { Card, Screen } from "@/components/onboarding/screen";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  permissionsOpenSettings,
  permissionsRequest,
  permissionsStatus,
  type PermissionId,
  type PermissionState,
  type PermissionStatus,
} from "@/lib/pointy";

const COPY: Record<PermissionId, { label: string; why: string; icon: typeof Mic }> = {
  microphone: {
    label: "Microphone",
    why: "So Pointy can hear the question. Listening and transcription run on your machine.",
    icon: Mic,
  },
  screen: {
    label: "Screen recording",
    why: "So Pointy can read the screen the moment you ask — one screenshot per question, never a rolling recording.",
    icon: Monitor,
  },
  accessibility: {
    label: "Accessibility",
    why: "So the dot lands on the exact button instead of near it.",
    icon: Crosshair,
  },
};

const STATE_LABEL: Record<PermissionState, string> = {
  granted: "Granted",
  denied: "Blocked",
  prompt: "Not set yet",
  unknown: "Unclear",
};

function StatePill({ state }: { state: PermissionState }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-sm font-medium",
        state === "granted" && "text-foreground",
        state === "denied" && "text-destructive",
        (state === "prompt" || state === "unknown") && "text-muted-foreground",
      )}
    >
      {state === "granted" ? (
        <Check className="size-4 text-accent" aria-hidden />
      ) : state === "denied" ? (
        <X className="size-4" aria-hidden />
      ) : null}
      <span
        className={cn(
          state === "granted" && "border-b-[2px] border-accent pb-[1px]"
        )}
      >
        {STATE_LABEL[state]}
      </span>
    </span>
  );
}

export function Permissions({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [statuses, setStatuses] = useState<PermissionStatus[]>([]);
  const [busy, setBusy] = useState<PermissionId | "all" | null>("all");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy("all");
    try {
      setStatuses(await permissionsStatus());
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Granting happens outside the app, in the OS settings window. Re-check whenever the
  // user comes back so the list is never stale.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const request = async (id: PermissionId) => {
    setBusy(id);
    try {
      const updated = await permissionsRequest(id);
      setStatuses((current) => current.map((s) => (s.id === id ? updated : s)));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const blocked = statuses.filter((status) => status.state !== "granted");
  const ready = statuses.length > 0 && blocked.length === 0;

  return (
    <Screen
      title="What Pointy needs access to"
      lede="Pointy stays idle until you trigger it. Nothing is captured in the background, and there is no recording buffer to leak."
      onBack={onBack}
      footnote="Screenshots and questions are used to answer, then dropped. Nothing is kept after the answer."
    >
      <Card className="p-0">
        <ul>
          {statuses.map((status, index) => {
            const copy = COPY[status.id];
            const Icon = copy.icon;
            return (
              <li
                key={status.id}
                className={cn(
                  "flex items-start gap-4 px-6 py-5",
                  index > 0 && "border-t border-border/70",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center",
                    status.state === "granted"
                      ? "text-accent"
                      : "text-muted-foreground",
                  )}
                >
                  <Icon className="size-5" aria-hidden />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="font-semibold">{copy.label}</span>
                    <StatePill state={status.state} />
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                    {copy.why}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground/75">
                    {status.detail}
                  </p>
                </div>

                {status.state !== "granted" && (
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void request(status.id)}
                    >
                      {busy === status.id && <Loader2 className="size-3.5 animate-spin" />}
                      {status.can_open_settings ? "Allow" : "Check again"}
                    </Button>
                    {status.can_open_settings && (
                      <button
                        type="button"
                        className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                        onClick={() => void permissionsOpenSettings(status.id)}
                      >
                        Open settings
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="flex items-center justify-between gap-4 border-t border-border/70 px-6 py-4">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={busy !== null}
            onClick={() => void refresh()}
          >
            {busy === "all" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCw className="size-3.5" />
            )}
            Re-check
          </Button>

          <div className="flex items-center gap-4">
            {!ready && statuses.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {blocked.length} of {statuses.length} still needed
              </span>
            )}
            <Button disabled={!ready} onClick={onNext}>
              Continue
            </Button>
          </div>
        </div>
      </Card>

      {error && <p className="mt-4 text-center text-sm text-destructive">{error}</p>}
    </Screen>
  );
}
