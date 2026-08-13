import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Crosshair,
  FileSpreadsheet,
  LayoutDashboard,
  MessagesSquare,
  RotateCcw,
  Settings2,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { GuideArrow } from "@/components/guide-arrow";
import { GuideDot } from "@/components/guide-dot";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Phase = "pick" | "asking" | "thinking" | "answer" | "pointer";

type Hotspot = {
  id: string;
  label: string;
  style: { top: string; left: string };
  tip: string;
};

type Scenario = {
  id: string;
  label: string;
  appName: string;
  icon: LucideIcon;
  accent: string;
  question: string;
  answer: string;
  advice: string;
  hotspots: Hotspot[];
  primaryHotspotId: string;
};

const SCENARIOS: Scenario[] = [
  {
    id: "design",
    label: "Design tools",
    appName: "Studio",
    icon: LayoutDashboard,
    accent: "from-forest/15 to-ochre/10",
    question: "Where do I export this as a PDF?",
    answer: "Open File → Export. Choose PDF, then Export on the right.",
    advice: "Most design apps bury export under File — not the share icon.",
    primaryHotspotId: "export",
    hotspots: [
      {
        id: "file",
        label: "1. File menu",
        style: { top: "12%", left: "14%" },
        tip: "Start here — File is in the top-left menu bar.",
      },
      {
        id: "export",
        label: "2. Export…",
        style: { top: "42%", left: "22%" },
        tip: "Click Export… — that’s the path to PDF.",
      },
      {
        id: "pdf",
        label: "3. PDF",
        style: { top: "48%", left: "78%" },
        tip: "Pick PDF in the format list, then confirm.",
      },
    ],
  },
  {
    id: "sheets",
    label: "Spreadsheets",
    appName: "Grid",
    icon: FileSpreadsheet,
    accent: "from-ochre/15 to-forest/10",
    question: "How do I freeze the top row?",
    answer: "Go to View → Freeze → Freeze top row. Your header stays put while you scroll.",
    advice: "Freeze lives under View, not Format — easy to miss.",
    primaryHotspotId: "freeze",
    hotspots: [
      {
        id: "view",
        label: "1. View",
        style: { top: "12%", left: "28%" },
        tip: "Open the View menu in the toolbar.",
      },
      {
        id: "freeze",
        label: "2. Freeze",
        style: { top: "40%", left: "30%" },
        tip: "Choose Freeze → Freeze top row.",
      },
    ],
  },
  {
    id: "work",
    label: "Work chat",
    appName: "Pulse",
    icon: MessagesSquare,
    accent: "from-forest/12 to-signal/10",
    question: "Where are my notification settings?",
    answer: "Click your avatar → Preferences → Notifications. Toggle what pings you.",
    advice: "It’s almost never in the channel sidebar — start from your profile.",
    primaryHotspotId: "prefs",
    hotspots: [
      {
        id: "avatar",
        label: "1. Your avatar",
        style: { top: "12%", left: "90%" },
        tip: "Open your profile menu from the top-right.",
      },
      {
        id: "prefs",
        label: "2. Preferences",
        style: { top: "38%", left: "82%" },
        tip: "Preferences opens the settings panel.",
      },
    ],
  },
  {
    id: "settings",
    label: "System settings",
    appName: "Settings",
    icon: Settings2,
    accent: "from-obsidian/10 to-forest/10",
    question: "How do I change the default browser?",
    answer: "Apps → Default apps → Web browser. Pick the browser you want.",
    advice: "Search “default” in Settings if the sidebar feels endless.",
    primaryHotspotId: "defaults",
    hotspots: [
      {
        id: "apps",
        label: "1. Apps",
        style: { top: "48%", left: "14%" },
        tip: "Select Apps in the left sidebar.",
      },
      {
        id: "defaults",
        label: "2. Default apps",
        style: { top: "55%", left: "48%" },
        tip: "Open Default apps, then Web browser.",
      },
    ],
  },
  {
    id: "new",
    label: "Anything new",
    appName: "Untitled",
    icon: Sparkles,
    accent: "from-signal/15 to-forest/10",
    question: "Where’s the share button on this screen?",
    answer: "Top-right toolbar — the Share button next to your avatar.",
    advice: "When you’re lost, scan the top-right first. That’s where actions usually live.",
    primaryHotspotId: "share",
    hotspots: [
      {
        id: "share",
        label: "1. Share",
        style: { top: "12%", left: "78%" },
        tip: "Click Share — that’s the one.",
      },
    ],
  },
];

/**
 * Interactive product sandbox for onboarding.
 * Pick an app → watch a person ask → hear Pointy’s answer → optionally reveal the pointer path.
 */
export function LiveSandbox({ onExperienced }: { onExperienced: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("pick");
  const [activeHotspot, setActiveHotspot] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  const scenario = SCENARIOS.find((entry) => entry.id === selectedId) ?? null;

  const clearTimers = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  };

  useEffect(() => () => clearTimers(), []);

  const startScenario = (id: string) => {
    clearTimers();
    setSelectedId(id);
    setPhase("asking");
    setActiveHotspot(null);

    timers.current.push(
      window.setTimeout(() => setPhase("thinking"), 1500),
      window.setTimeout(() => {
        setPhase("answer");
        onExperienced();
      }, 2500),
    );
  };

  const showPointer = () => {
    if (!scenario) return;
    setPhase("pointer");
    setActiveHotspot(scenario.primaryHotspotId);
    onExperienced();
  };

  const reset = () => {
    clearTimers();
    setSelectedId(null);
    setPhase("pick");
    setActiveHotspot(null);
  };

  const focused =
    scenario?.hotspots.find((h) => h.id === activeHotspot) ??
    scenario?.hotspots.find((h) => h.id === scenario.primaryHotspotId) ??
    null;

  return (
    <div className="flex w-full flex-col gap-4">
      <AnimatePresence mode="wait">
        {phase === "pick" && (
          <motion.div
            key="pick"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
          >
            {SCENARIOS.map((entry, i) => {
              const Icon = entry.icon;
              return (
                <motion.button
                  key={entry.id}
                  type="button"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.04 * i }}
                  onClick={() => startScenario(entry.id)}
                  className={cn(
                    "group relative overflow-hidden rounded-2xl border border-border/60 bg-card p-4 text-left shadow-sm transition-all",
                    "hover:-translate-y-0.5 hover:border-forest/30 hover:shadow-[0_18px_40px_-28px_rgba(46,58,71,0.35)]",
                  )}
                >
                  <div
                    className={cn(
                      "absolute inset-0 bg-gradient-to-br opacity-0 transition-opacity group-hover:opacity-100",
                      entry.accent,
                    )}
                  />
                  <div className="relative flex items-start gap-3">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-secondary text-forest">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold">{entry.label}</span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        Click to see Pointy help in {entry.appName}
                      </span>
                    </span>
                  </div>
                </motion.button>
              );
            })}
          </motion.div>
        )}

        {scenario && phase !== "pick" && (
          <motion.div
            key={scenario.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-[0_22px_48px_-28px_rgba(46,58,71,0.3)]"
          >
            <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 items-center justify-center rounded-lg bg-secondary">
                  <scenario.icon className="size-3.5 text-forest" aria-hidden />
                </span>
                <div>
                  <p className="text-sm font-semibold">{scenario.appName}</p>
                  <p className="text-[0.6875rem] text-muted-foreground">
                    Live example · not your real screen
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <RotateCcw className="size-3.5" aria-hidden />
                Try another
              </button>
            </div>

            <div className="grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
              <MockApp
                scenario={scenario}
                phase={phase}
                activeHotspot={activeHotspot}
                onHotspotFocus={setActiveHotspot}
              />

              <aside className="flex flex-col border-t border-border/50 bg-secondary/25 p-5 lg:border-t-0 lg:border-l">
                <PhasePanel
                  scenario={scenario}
                  phase={phase}
                  focused={focused}
                  onShowPointer={showPointer}
                />
              </aside>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PhasePanel({
  scenario,
  phase,
  focused,
  onShowPointer,
}: {
  scenario: Scenario;
  phase: Phase;
  focused: Hotspot | null;
  onShowPointer: () => void;
}) {
  return (
    <div className="flex h-full min-h-[16rem] flex-col">
      <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {phase === "asking" && "Someone asks"}
        {phase === "thinking" && "Pointy is reading the screen"}
        {phase === "answer" && "Pointy answers"}
        {phase === "pointer" && "Pointer path"}
      </p>

      <div className="mt-3 flex-1">
        <AnimatePresence mode="wait">
          {(phase === "asking" || phase === "thinking") && (
            <motion.div
              key="q"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
            >
              <p className="font-serif text-[1.35rem] leading-snug tracking-tight text-foreground">
                “{scenario.question}”
              </p>
              {phase === "thinking" && (
                <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        className="size-1.5 rounded-full bg-forest"
                        animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
                        transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }}
                      />
                    ))}
                  </span>
                  Reading the open window…
                </div>
              )}
            </motion.div>
          )}

          {(phase === "answer" || phase === "pointer") && (
            <motion.div
              key="a"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <p className="text-[0.95rem] leading-relaxed text-foreground">{scenario.answer}</p>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{scenario.advice}</p>

              {phase === "pointer" && focused && (
                <motion.div
                  key={focused.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-4 rounded-xl border border-signal/30 bg-signal/10 px-3.5 py-3"
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <GuideDot size="sm" />
                    {focused.label}
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{focused.tip}</p>
                  <p className="mt-2 text-[0.6875rem] text-muted-foreground/80">
                    Click the numbered dots on the screen to step through.
                  </p>
                </motion.div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {phase === "answer" && (
        <div className="mt-5">
          <Button onClick={onShowPointer} className="h-11 w-full rounded-xl sm:w-auto">
            <Crosshair className="size-4" aria-hidden />
            Show me where to click
          </Button>
        </div>
      )}

      {phase === "pointer" && (
        <p className="mt-5 text-xs text-muted-foreground">
          This is what Pointy does for real — answer first, then point.
        </p>
      )}
    </div>
  );
}

function MockApp({
  scenario,
  phase,
  activeHotspot,
  onHotspotFocus,
}: {
  scenario: Scenario;
  phase: Phase;
  activeHotspot: string | null;
  onHotspotFocus: (id: string) => void;
}) {
  const showPointer = phase === "pointer";
  const primary = scenario.primaryHotspotId;

  return (
    <div className={cn("relative min-h-[18rem] bg-gradient-to-br p-4", scenario.accent)}>
      <div className="relative h-full min-h-[16.5rem] overflow-hidden rounded-xl border border-border/50 bg-[#f3f5f7] shadow-inner">
        <div className="flex items-center gap-1.5 border-b border-border/40 bg-white/80 px-3 py-2">
          <span className="size-2 rounded-full bg-foreground/12" />
          <span className="size-2 rounded-full bg-foreground/12" />
          <span className="size-2 rounded-full bg-foreground/12" />
          <span className="ml-2 text-[0.625rem] font-medium text-muted-foreground">
            {scenario.appName}
          </span>
          <span className="ml-auto rounded-md bg-secondary px-2 py-0.5 text-[0.625rem] font-medium text-muted-foreground">
            Share
          </span>
          <span className="size-5 rounded-full bg-forest/20" />
        </div>

        <div className="relative h-[calc(100%-2.25rem)] p-3">
          <div className="absolute top-3 left-3 flex gap-2">
            {["File", "Edit", "View"].map((item) => (
              <span
                key={item}
                className="rounded-md bg-white/90 px-2 py-1 text-[0.625rem] font-medium text-muted-foreground shadow-sm"
              >
                {item}
              </span>
            ))}
          </div>

          <div className="absolute top-14 left-3 w-28 rounded-lg border border-border/40 bg-white/90 p-2 shadow-sm">
            <div className="space-y-1.5">
              <div className="h-1.5 w-16 rounded bg-foreground/10" />
              <div className="h-1.5 w-20 rounded bg-foreground/10" />
              <div className="rounded-md bg-forest/10 px-1.5 py-1 text-[0.6rem] font-medium text-forest">
                Export…
              </div>
              <div className="h-1.5 w-14 rounded bg-foreground/10" />
            </div>
          </div>

          <div className="absolute top-14 right-4 w-32 rounded-lg border border-border/40 bg-white/90 p-2 shadow-sm">
            <p className="text-[0.6rem] font-semibold text-muted-foreground">Format</p>
            <div className="mt-2 space-y-1">
              <div className="rounded bg-secondary px-1.5 py-1 text-[0.6rem]">PNG</div>
              <div className="rounded bg-signal/20 px-1.5 py-1 text-[0.6rem] font-semibold text-foreground">
                PDF
              </div>
              <div className="rounded bg-secondary px-1.5 py-1 text-[0.6rem]">SVG</div>
            </div>
          </div>

          <div className="absolute right-3 bottom-4 left-3 h-14 rounded-lg border border-dashed border-border/50 bg-white/50" />

          <AnimatePresence>
            {(phase === "asking" || phase === "thinking") && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                className="absolute bottom-6 left-1/2 z-20 w-[min(100%,16rem)] -translate-x-1/2 rounded-2xl border border-border/60 bg-card px-3.5 py-3 shadow-lg"
              >
                <div className="flex items-center gap-2">
                  <span className="size-7 shrink-0 rounded-full bg-gradient-to-br from-forest/30 to-ochre/40" />
                  <p className="text-xs font-medium leading-snug text-foreground">
                    “{scenario.question}”
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {showPointer &&
            scenario.hotspots.map((spot, index) => {
              const active = activeHotspot === spot.id;
              const isPrimary = spot.id === primary;
              return (
                <button
                  key={spot.id}
                  type="button"
                  onClick={() => onHotspotFocus(spot.id)}
                  className="absolute z-30 -translate-x-1/2 -translate-y-1/2"
                  style={spot.style}
                  aria-label={spot.label}
                >
                  <span className="relative flex items-center justify-center">
                    {isPrimary && <GuideArrow visible={active} />}
                    <GuideDot size={active ? "lg" : "md"} label={index + 1} />
                    {active && (
                      <motion.span
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="absolute top-full z-10 mt-2 whitespace-nowrap rounded-md bg-obsidian px-2 py-1 text-[0.625rem] font-medium text-white shadow-lg"
                      >
                        {spot.label}
                      </motion.span>
                    )}
                  </span>
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
}
