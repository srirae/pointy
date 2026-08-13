import { useCallback, useEffect, useState } from "react";
import { Check, Crosshair, Loader2, Mic, Monitor, RotateCw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { GuideDot } from "@/components/guide-dot";
import { Card, Screen } from "@/components/onboarding/screen";
import { Button } from "@/components/ui/button";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  REQUIRED_PERMISSIONS,
  permissionsOpenSettings,
  permissionsRequest,
  permissionsStatus,
  type PermissionId,
  type PermissionState,
  type PermissionStatus,
} from "@/lib/pointy";

const COPY: Record<
  PermissionId,
  { label: string; why: string; visual: string; icon: typeof Mic }
> = {
  microphone: {
    label: "Microphone",
    why: "So Pointy can hear the question. Listening and transcription run on your machine.",
    visual: "Hears you",
    icon: Mic,
  },
  screen: {
    label: "Screen recording",
    why: "So Pointy can read the screen the moment you ask — one screenshot per question, never a rolling recording.",
    visual: "Sees the window",
    icon: Monitor,
  },
  accessibility: {
    label: "Accessibility",
    why: "So the guide-dot lands on the exact button instead of near it.",
    visual: "Points precisely",
    icon: Crosshair,
  },
};

const STATE_LABEL: Record<PermissionState, string> = {
  granted: "Granted",
  denied: "Blocked",
  prompt: "Not set yet",
  unknown: "Unclear",
};

const EMPTY_STATUSES: PermissionStatus[] = REQUIRED_PERMISSIONS.map((id) => ({
  id,
  state: "prompt" as const,
  detail: "Checking…",
  can_open_settings: false,
}));

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
      <span className={cn(state === "granted" && "border-b-[2px] border-accent pb-[1px]")}>
        {STATE_LABEL[state]}
      </span>
    </span>
  );
}

function friendlyError(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason);
  if (raw.includes("invoke") || raw.includes("Tauri") || raw.includes("PREVIEW")) {
    return "Couldn’t reach system permissions. You can still continue in preview, or relaunch the desktop app.";
  }
  return "Something went wrong checking permissions. Try Re-check.";
}

export function Permissions({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [statuses, setStatuses] = useState<PermissionStatus[]>(EMPTY_STATUSES);
  const [busy, setBusy] = useState<PermissionId | "all" | null>("all");
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState(!isTauri());
  const [highlight, setHighlight] = useState<PermissionId>("microphone");

  const refresh = useCallback(async () => {
    setBusy("all");
    try {
      const next = await permissionsStatus();
      if (Array.isArray(next) && next.length > 0) {
        setStatuses(next);
        setNotice(null);
        setPreview(!isTauri());
      }
    } catch (reason) {
      setNotice(friendlyError(reason));
      setPreview(true);
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // Cycle the mini visual so the page never feels empty while waiting.
  useEffect(() => {
    const order = REQUIRED_PERMISSIONS;
    const timer = window.setInterval(() => {
      setHighlight((current) => {
        const index = order.indexOf(current);
        return order[(index + 1) % order.length]!;
      });
    }, 2800);
    return () => window.clearInterval(timer);
  }, []);

  const request = async (id: PermissionId) => {
    setBusy(id);
    setHighlight(id);
    try {
      const updated = await permissionsRequest(id);
      setStatuses((current) => current.map((s) => (s.id === id ? updated : s)));
      setNotice(null);
    } catch (reason) {
      setNotice(friendlyError(reason));
    } finally {
      setBusy(null);
    }
  };

  const blocked = statuses.filter((status) => status.state !== "granted");
  const ready = statuses.length > 0 && blocked.length === 0;
  const grantedCount = statuses.filter((s) => s.state === "granted").length;

  return (
    <Screen
      title="Three permissions. That’s it."
      lede="Hear, see, then point — mic, screen, and accessibility. Nothing is captured until you hold your hotkey."
      onBack={onBack}
      footnote="Screenshots and questions are used to answer, then dropped. Nothing is kept after the answer."
      wide
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <PermissionStory highlight={highlight} granted={grantedCount} total={statuses.length} />

        <Card className="p-0">
          <ul>
            {statuses.map((status, index) => {
              const copy = COPY[status.id];
              const Icon = copy.icon;
              const active = highlight === status.id;
              return (
                <li
                  key={status.id}
                  className={cn(
                    "flex items-start gap-4 px-5 py-4 transition-colors",
                    index > 0 && "border-t border-border/60",
                    active && "bg-forest/[0.03]",
                  )}
                  onMouseEnter={() => setHighlight(status.id)}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors",
                      status.state === "granted"
                        ? "bg-forest/10 text-forest"
                        : active
                          ? "bg-ochre/20 text-foreground"
                          : "bg-secondary text-muted-foreground",
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <span className="font-semibold">{copy.label}</span>
                      <StatePill state={status.state} />
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{copy.why}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground/75">
                      {status.detail}
                    </p>
                  </div>

                  {status.state !== "granted" && (
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-lg"
                        disabled={busy !== null}
                        onClick={() => void request(status.id)}
                      >
                        {busy === status.id && <Loader2 className="size-3.5 animate-spin" />}
                        {preview ? "Allow (preview)" : status.can_open_settings ? "Allow" : "Check again"}
                      </Button>
                      {!preview && status.can_open_settings && (
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

          <div className="flex items-center justify-between gap-4 border-t border-border/60 px-5 py-4">
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
              {!ready && (
                <span className="text-xs text-muted-foreground">
                  {blocked.length} of {statuses.length} still needed
                </span>
              )}
              <Button disabled={!ready} onClick={onNext} className="rounded-xl px-6">
                Continue
              </Button>
            </div>
          </div>
        </Card>
      </div>

      {preview && (
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Preview mode — grants are simulated here. In the installed app, these open real OS prompts.
        </p>
      )}
      {notice && (
        <p className="mt-3 text-center text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      )}
    </Screen>
  );
}

function PermissionStory({
  highlight,
  granted,
  total,
}: {
  highlight: PermissionId;
  granted: number;
  total: number;
}) {
  const copy = COPY[highlight];
  const Icon = copy.icon;

  return (
    <Card className="relative overflow-hidden p-0">
      <div className="absolute inset-0 bg-gradient-to-br from-forest/[0.07] via-card to-ochre/[0.1]" />
      <div className="relative flex h-full min-h-[22rem] flex-col p-6">
        <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Why we ask
        </p>
        <h2 className="mt-2 text-[1.5rem] font-bold leading-tight tracking-[-0.03em]">
          Hear → see → point
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Hover a permission to see its role. You’ll try the full loop in Word on the last step.
        </p>

        <div className="relative mt-8 flex flex-1 flex-col items-center justify-center">
          <div className="relative flex h-40 w-full max-w-[16rem] items-center justify-center rounded-2xl border border-border/50 bg-card/80 shadow-sm">
            <AnimatePresence mode="wait">
              <motion.div
                key={highlight}
                initial={{ opacity: 0, scale: 0.92, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: -6 }}
                transition={{ type: "spring", stiffness: 380, damping: 28 }}
                className="flex flex-col items-center gap-3 px-4 text-center"
              >
                <span className="flex size-12 items-center justify-center rounded-2xl bg-forest/10 text-forest">
                  <Icon className="size-5" aria-hidden />
                </span>
                <div>
                  <p className="text-sm font-semibold">{copy.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{copy.visual}</p>
                </div>
                {highlight === "accessibility" && (
                  <div className="relative mt-1">
                    <GuideDot size="lg" />
                  </div>
                )}
              </motion.div>
            </AnimatePresence>

            <div className="absolute inset-x-6 bottom-4 flex justify-between">
              {REQUIRED_PERMISSIONS.map((id) => (
                <span
                  key={id}
                  className={cn(
                    "h-1 w-8 rounded-full transition-colors",
                    id === highlight ? "bg-forest" : "bg-foreground/10",
                  )}
                />
              ))}
            </div>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          {granted} of {total} granted
        </p>
      </div>
    </Card>
  );
}
