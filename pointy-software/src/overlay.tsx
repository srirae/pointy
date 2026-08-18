import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { AnimatePresence, motion } from "motion/react";

import { AskWindow, type Turn } from "@/components/overlay/ask-window";
import { ClickHint } from "@/components/overlay/click-hint";
import { useOverlayVoice } from "@/hooks/use-overlay-voice";
import {
  onHotkeyDown,
  onHotkeyUp,
  onOverlayHidden,
  overlayHide,
  overlaySetHitRect,
  guideStart,
  guideStop,
  onGuideStep,
  onGuideWarn,
  onGuideDiagnostic,
  overlaySetPassthrough,
  usageQuestion,
  wakeSetTranscript,
  windowsList,
  speakText,
  stopSpeaking,
  onPointClicked,
  pointUnwatch,
  pointWatch,
  type AppWindow,
  type GuideStep,
} from "@/lib/pointy";
import {
  askAboutScreen,
  locatePoint,
  targetToScreen,
  type PointSpot,
} from "@/lib/screen-ask";

/** Earlier exchanges handed to the model so follow-up questions make sense. */
const HISTORY_TURNS = 4;

/**
 * The overlay session.
 *
 * Wake picks an app, then questions about that app accumulate as a conversation.
 * The mic only ever opens while `listening` is true, which needs a deliberate
 * hotkey hold or mic tap — the webview is mounted for the whole process life, so
 * anything else would record the room in the background.
 *
 * When an answer says the task is multi-step, the guided walkthrough starts
 * automatically: it watches the real accessibility tree for completion of each
 * step and asks the model for the next one — no wake word needed in between.
 */
export function Overlay() {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [picking, setPicking] = useState(false);

  const [windows, setWindows] = useState<AppWindow[]>([]);
  const [windowsLoading, setWindowsLoading] = useState(false);
  const [windowsError, setWindowsError] = useState<string | null>(null);

  const [scope, setScope] = useState<AppWindow | null>(null);
  const [scopeChosen, setScopeChosen] = useState(false);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [listenGen, setListenGen] = useState(0);
  /** The glow currently on screen, resolved when the user asked to be shown. */
  const [point, setPoint] = useState<{ turnId: number; spot: PointSpot } | null>(null);
  const [locatingTurn, setLocatingTurn] = useState<number | null>(null);
  const [copiedTurn, setCopiedTurn] = useState<number | null>(null);
  const [speakingTurn, setSpeakingTurn] = useState<number | null>(null);
  const [pos, setPos] = useState(() => defaultPos());
  /** Answers are text first. Speech is opt-in, per answer or as an auto-read. */
  const [speak, setSpeak] = useState(false);
  const [guide, setGuide] = useState<{ active: boolean; task: string; step: number }>({
    active: false,
    task: "",
    step: 1,
  });
  const [guideStep, setGuideStep] = useState<GuideStep | null>(null);
  /** Timestamp of the last misclick warning, so the dot can flash briefly. */
  const [guideWarn, setGuideWarn] = useState<number | null>(null);
  const [guidePhase, setGuidePhase] = useState("waiting_for_action");

  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turnSeq = useRef(0);
  const spokenIds = useRef(new Set<number>());
  /** Resets the Listen label once the estimated reading time has elapsed. */
  const speechTimer = useRef<number | null>(null);
  /** False once the user types, so speech stops overwriting their edits. */
  const dictating = useRef(false);
  /** Set true when the user stops the walkthrough, so late backend events
   * cannot re-show the banner or speak after Stop. */
  const guideStoppedRef = useRef(false);

  const voice = useOverlayVoice(listening, listenGen);
  const busy = turns.some((turn) => turn.status === "asking");

  const posRef = useRef(pos);
  posRef.current = pos;
  const flushRef = useRef(voice.flush);
  flushRef.current = voice.flush;

  const live = useRef({
    open,
    picking,
    listening,
    scopeChosen,
    scope,
    busy,
    draft,
    turns,
  });
  live.current = { open, picking, listening, scopeChosen, scope, busy, draft, turns };

  // ---------------------------------------------------------------- plumbing

  // Clicks land on the app underneath except over the card. Kept on while Pointy
  // is thinking, so the screen never freezes mid-answer.
  const passthrough = open && !listening && !leaving;
  useEffect(() => {
    void overlaySetPassthrough(passthrough);
  }, [passthrough]);

  useEffect(() => {
    if (!open || leaving) return;
    const node = cardRef.current;
    if (!node) return;

    const report = () => {
      const rect = node.getBoundingClientRect();
      void overlaySetHitRect({
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
      });
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    const timer = window.setInterval(report, 120);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [open, leaving]);

  useEffect(() => {
    if (listening && dictating.current && voice.transcript) setDraft(voice.transcript);
  }, [listening, voice.transcript]);

  useEffect(() => {
    if (copiedTurn === null) return;
    const timer = window.setTimeout(() => setCopiedTurn(null), 1400);
    return () => window.clearTimeout(timer);
  }, [copiedTurn]);

  // The glow has done its job the moment the user clicks what it framed, so it
  // gets out of the way on its own. The overlay is click-through here, so the
  // click can only be seen from the OS side.
  useEffect(() => {
    if (!point) {
      void pointUnwatch();
      return;
    }
    void pointWatch(point.spot.target);
    return () => void pointUnwatch();
  }, [point]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onPointClicked(() => {
      if (!cancelled) setPoint(null);
    }).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // All user-facing speech uses the local Piper-first Rust path. Keeping this
  // out of Web Speech avoids browser-dependent voices and duplicate playback.
  const speakAloud = useCallback((text: string) => {
    if (!text.trim()) return;
    void speakText(text);
  }, []);

  // Auto-read is off by default: the answer is text, and speech is something the
  // user asks for. When they do turn it on, only newly-finished turns are read.
  useEffect(() => {
    if (!speak) return;
    for (const turn of turns) {
      if (turn.status !== "done" || !turn.answer || spokenIds.current.has(turn.id)) continue;
      spokenIds.current.add(turn.id);
      const text = plainSpeech(turn.answer);
      if (!text) continue;
      speakAloud(text);
    }
  }, [turns, speak, speakAloud]);

  const hushSpeech = useCallback(() => {
    if (speechTimer.current !== null) {
      window.clearTimeout(speechTimer.current);
      speechTimer.current = null;
    }
    setSpeakingTurn(null);
  }, []);

  useEffect(() => () => hushSpeech(), [hushSpeech]);

  /** Read one answer aloud, or stop the one that is playing. */
  const listen = useCallback(
    (turn: Turn) => {
      const stopping = speakingTurn === turn.id;
      void stopSpeaking();
      hushSpeech();
      if (stopping) return;

      const text = plainSpeech(turn.answer);
      if (!text) return;
      spokenIds.current.add(turn.id); // don't let auto-read repeat it
      setSpeakingTurn(turn.id);
      speakAloud(text);

      // The voice reports no completion event, so the button label is restored
      // on a rough reading-time estimate. Stop stays accurate either way.
      speechTimer.current = window.setTimeout(
        () => {
          speechTimer.current = null;
          setSpeakingTurn(null);
        },
        900 + (text.length / 13) * 1000,
      );
    },
    [hushSpeech, speakAloud, speakingTurn],
  );

  // Walkthrough events arrive from the backend; speak them as they land.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onGuideStep((step) => {
      if (cancelled || guideStoppedRef.current) return;
      // Streaming emits speech before the full target JSON arrives. Update only
      // the sentence so the already-correct dot never disappears mid-request.
      if (step.kind === "speech") {
        setGuideStep((current) =>
          current ? { ...current, say: step.say, speak: false } : step,
        );
      } else {
        setGuideStep(step);
      }
      setGuideWarn(null);
      if (step.kind === "done") {
        setGuide((g) => ({ ...g, active: false }));
        void guideStop();
      }
    }).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Trust Layer diagnostics are local and make it clear why Pointy is waiting
  // or advancing without exposing model plumbing to the user.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onGuideDiagnostic((diagnostic) => {
      if (cancelled || guideStoppedRef.current) return;
      setGuidePhase(diagnostic.phase);
    }).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Misclick warning: brighten the correct dot for a moment. Audio is played by
  // the backend (pre-cached), so here we only drive the visual pulse.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onGuideWarn(() => {
      if (cancelled || guideStoppedRef.current) return;
      setGuideWarn(Date.now());
    }).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (guideWarn === null) return;
    const timer = window.setTimeout(() => setGuideWarn(null), 1300);
    return () => window.clearTimeout(timer);
  }, [guideWarn]);

  useEffect(() => {
    if (!guideStep || !speak || guideStep.speak === false) return;
    const text = plainSpeech(guideStep.say);
    if (!text) return;
    speakAloud(text);
  }, [guideStep, speak, speakAloud]);

  // ---------------------------------------------------------------- session

  const loadWindows = useCallback(() => {
    setWindowsLoading(true);
    setWindowsError(null);
    windowsList()
      .then((found) => setWindows(found))
      .catch((reason) =>
        setWindowsError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setWindowsLoading(false));
  }, []);

  const resetSession = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    void stopSpeaking();
    hushSpeech();
    spokenIds.current.clear();
    guideStoppedRef.current = true;
    void guideStop();
    setGuide({ active: false, task: "", step: 1 });
    setGuideStep(null);
    setGuideWarn(null);
    setGuidePhase("waiting_for_action");
    setOpen(false);
    setLeaving(false);
    setPicking(false);
    setScope(null);
    setScopeChosen(false);
    setTurns([]);
    setDraft("");
    setListening(false);
    setPoint(null);
    setLocatingTurn(null);
    setWindows([]);
  }, [hushSpeech]);

  const close = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setListening(false);
    setLeaving(true);
    window.setTimeout(() => {
      void overlayHide();
      resetSession();
    }, 170);
  }, [resetSession]);

  const startListening = useCallback(() => {
    dictating.current = true;
    setListenGen((n) => n + 1);
    setListening(true);
  }, []);

  /**
   * Release the mic and return the question as it now stands. Flush runs first
   * because it owns the audio hardware and produces the final transcript.
   * `keep` is false when the user has taken over by typing.
   */
  const stopListening = useCallback(async (keep = true): Promise<string> => {
    if (!live.current.listening) return live.current.draft;
    const heard = await flushRef.current();
    dictating.current = false;
    setListening(false);
    if (!keep) return live.current.draft;
    if (heard) setDraft(heard);
    return heard || live.current.draft;
  }, []);

  // ---------------------------------------------------------------- asking

  const run = useCallback(async (turnId: number, question: string, app: AppWindow | null) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const settle = (patch: Partial<Turn>) =>
      setTurns((current) =>
        current.map((turn) => (turn.id === turnId ? { ...turn, ...patch } : turn)),
      );

    void wakeSetTranscript(question);

    try {
      // Usage questions are answered locally — no screenshot, no API call.
      const usage = await usageQuestion(question);
      if (ctrl.signal.aborted) return;
      if (usage) {
        settle({ status: "done", answer: usage, target: null, dot: null, error: null });
        return;
      }

      // Only exchanges that came before this one, so a retry never quotes the
      // answers that followed it.
      const history = live.current.turns
        .filter((prior) => prior.id < turnId && prior.status === "done" && prior.answer)
        .slice(-HISTORY_TURNS)
        .map((prior) => ({ question: prior.question, answer: prior.answer }));

      const reply = await askAboutScreen(
        question,
        app?.id ?? null,
        app?.app ?? null,
        history,
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      const target = reply.target ? targetToScreen(reply.target, reply) : null;
      settle({
        status: "done",
        answer: visibleAnswer(reply.answer, reply.advice),
        target,
        dot: reply.dot ?? null,
        error: null,
      });

      // Multi-step task → start the guided walkthrough automatically. The first
      // step is the answer we just got; the backend begins watching the
      // accessibility tree for its completion.
      if (canStartGuide(reply)) {
        spokenIds.current.add(turnId); // the walkthrough speaks step one once
        guideStoppedRef.current = false;
        setGuide({ active: true, task: question, step: 1 });
        setGuideStep({
          kind: "step",
          step: 1,
          say: reply.answer,
          action: reply.action,
          confidence: reply.confidence,
          target: reply.target, // shot-relative; mapped by targetToScreen
          dot: reply.dot ?? null,
          x: reply.x,
          y: reply.y,
          w: reply.w,
          h: reply.h,
          speak: true,
        });
        void guideStart(
          question,
          app?.id ?? null,
          reply.target?.label ?? null,
          reply.action,
          reply.confidence,
        );
      }
    } catch (reason) {
      if (ctrl.signal.aborted) return;
      settle({
        status: "error",
        error:
          reason instanceof Error ? reason.message : "Couldn’t reach OpenRouter. Try again.",
      });
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }, []);

  const send = useCallback(async () => {
    if (live.current.busy || !live.current.scopeChosen) return;

    const spoken = live.current.listening ? await stopListening() : live.current.draft;
    const question = (spoken || "").trim();
    if (!question) return;

    const id = ++turnSeq.current;
    setDraft("");
    setPoint(null);
    setTurns((current) => [
      ...current,
      { id, question, answer: "", target: null, dot: null, status: "asking", error: null },
    ]);
    void run(id, question, live.current.scope);
  }, [run, stopListening]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setTurns((current) =>
      current.map((turn) => (turn.status === "asking" ? { ...turn, status: "stopped" } : turn)),
    );
  }, []);

  const edit = useCallback((turn: Turn) => {
    abortRef.current?.abort();
    abortRef.current = null;
    setTurns((current) => current.filter((kept) => kept.id !== turn.id));
    setPoint((current) => (current?.turnId === turn.id ? null : current));
    setDraft(turn.question);
  }, []);

  const retry = useCallback(
    (turn: Turn) => {
      if (live.current.busy) return;
      setPoint((current) => (current?.turnId === turn.id ? null : current));
      setTurns((current) =>
        current.map((kept) =>
          kept.id === turn.id
            ? { ...kept, status: "asking", answer: "", target: null, dot: null, error: null }
            : kept,
        ),
      );
      void run(turn.id, turn.question, live.current.scope);
    },
    [run],
  );

  const pick = useCallback(
    (chosen: AppWindow | null) => {
      setScope(chosen);
      setScopeChosen(true);
      setPicking(false);
      startListening();
    },
    [startListening],
  );

  const changeApp = useCallback(() => {
    void stopListening();
    setPicking(true);
    setPoint(null);
    loadWindows();
  }, [loadWindows, stopListening]);

  const stopGuide = useCallback(() => {
    guideStoppedRef.current = true;
    void guideStop();
    void stopSpeaking();
    setGuide((g) => ({ ...g, active: false }));
    setGuideStep(null);
    setGuideWarn(null);
    setGuidePhase("waiting_for_action");
  }, []);

  const repeatGuide = useCallback(() => {
    // Replay the instruction already on screen. Keeping this local avoids a
    // second backend event and guarantees the first step can be repeated before
    // the guide thread has emitted anything.
    if (guideStep?.say) speakAloud(guideStep.say);
  }, [guideStep, speakAloud]);

  /**
   * Show or hide the glow for one answer.
   *
   * The box that arrived with the answer describes the screen as it was when the
   * question was sent. Rather than trust it, the control is looked up again here,
   * at the moment the user asks to be shown — so scrolling or moving the window
   * in between no longer leaves the glow behind on empty space.
   */
  const togglePoint = useCallback(
    async (turn: Turn) => {
      if (point?.turnId === turn.id) {
        setPoint(null);
        return;
      }
      if (!turn.target) return;

      setLocatingTurn(turn.id);
      try {
        const spot = await locatePoint(turn.target.label, live.current.scope?.id ?? null, {
          target: turn.target,
        });
        setPoint({ turnId: turn.id, spot });
      } finally {
        setLocatingTurn((current) => (current === turn.id ? null : current));
      }
    },
    [point],
  );

  const copy = useCallback((turn: Turn) => {
    void navigator.clipboard?.writeText(turn.answer).catch(() => {});
    setCopiedTurn(turn.id);
  }, []);

  // ---------------------------------------------------------------- hotkey

  const wake = useCallback(() => {
    if (!live.current.open) {
      turnSeq.current = 0;
      setLeaving(false);
      setTurns([]);
      setDraft("");
      setScope(null);
      setScopeChosen(false);
      setPoint(null);
      setPicking(true);
      setOpen(true);
      loadWindows();
      return;
    }
    // Already up: a hold is push-to-talk, once there is something to talk about.
    if (live.current.scopeChosen && !live.current.listening) startListening();
  }, [loadWindows, startListening]);

  const release = useCallback(() => {
    if (live.current.listening) void stopListening();
  }, [stopListening]);

  const hotkeyRef = useRef({ wake, release, resetSession });
  hotkeyRef.current = { wake, release, resetSession };

  useEffect(() => {
    const offs: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      const down = await onHotkeyDown(() => hotkeyRef.current.wake());
      const up = await onHotkeyUp(() => hotkeyRef.current.release());
      const hidden = await onOverlayHidden(() => hotkeyRef.current.resetSession());
      if (cancelled) {
        down();
        up();
        hidden();
        return;
      }
      offs.push(down, up, hidden);
    })();

    return () => {
      cancelled = true;
      offs.forEach((off) => off());
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (point !== null) {
        setPoint(null);
        return;
      }
      if (busy) {
        stop();
        return;
      }
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, close, point, stop]);

  // ---------------------------------------------------------------- render

  const headerProps = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        dx: event.clientX - posRef.current.x,
        dy: event.clientY - posRef.current.y,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      setPos({
        x: clamp(event.clientX - dragRef.current.dx, 200, window.innerWidth - 200),
        y: clamp(event.clientY - dragRef.current.dy, 16, window.innerHeight - 140),
      });
    },
    onPointerUp: () => {
      dragRef.current = null;
    },
  };

  const guideTarget = guideStep?.target ? targetToScreen(guideStep.target, guideStep) : null;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-transparent">
      <AnimatePresence>
        {!leaving && listening && (
          <motion.div
            key="frost"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0"
            style={{
              background: "rgba(12, 16, 20, 0.16)",
              backdropFilter: "blur(2px)",
              WebkitBackdropFilter: "blur(2px)",
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!leaving && point && (
          <motion.div
            key="hint"
            className="absolute inset-0 z-[5]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <ClickHint target={point.spot.target} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!leaving && !point && guideTarget && (
          <motion.div
            key="guide-hint"
            className="absolute inset-0 z-[5]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <ClickHint target={guideTarget} flash={guideWarn !== null} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!leaving && open && (
          <motion.div
            key="card"
            className="pointer-events-auto absolute z-10"
            style={{ left: pos.x, top: pos.y }}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <div ref={cardRef} className="absolute top-0 left-0 -translate-x-1/2">
              <AskWindow
                picking={picking}
                scope={scope}
                scopeChosen={scopeChosen}
                windows={windows}
                windowsLoading={windowsLoading}
                windowsError={windowsError}
                onPick={pick}
                onRefreshWindows={loadWindows}
                onChangeApp={changeApp}
                turns={turns}
                draft={draft}
                onDraftChange={(value) => {
                  // Typing takes over from dictation instead of fighting it.
                  dictating.current = false;
                  if (live.current.listening) void stopListening(false);
                  setDraft(value);
                }}
                onSend={() => void send()}
                onStop={stop}
                busy={busy}
                listening={listening}
                bands={voice.bands}
                onToggleMic={() => {
                  if (listening) void stopListening();
                  else startListening();
                }}
                micError={listening ? voice.error : null}
                onEdit={edit}
                onRetry={retry}
                pointedTurn={point?.turnId ?? null}
                locatingTurn={locatingTurn}
                onTogglePoint={(turn) => void togglePoint(turn)}
                copiedTurn={copiedTurn}
                onCopy={copy}
                speakingTurn={speakingTurn}
                onListen={listen}
                speakEnabled={speak}
                onToggleSpeak={() => setSpeak((s) => !s)}
                guideActive={guide.active}
                guidePhase={guidePhase}
                guideStep={guideStep}
                onRepeatGuide={repeatGuide}
                onStopGuide={stopGuide}
                onClose={close}
                headerProps={headerProps}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function defaultPos() {
  if (typeof window === "undefined") return { x: 400, y: 280 };
  return {
    x: Math.max(200, window.innerWidth - 220),
    y: Math.max(24, window.innerHeight * 0.24),
  };
}

/** Markdown emphasis is for the eye; strip it before anything is read aloud. */
function plainSpeech(text: string) {
  return text.replace(/[*_`#>\[\]()~]/g, "").trim();
}

/** Keep model plumbing — JSON, coordinate dumps — out of the glass. */
function visibleAnswer(answer: string, advice: string) {
  const main = stripModelJunk(answer);
  const extra = stripModelJunk(advice);
  if (!extra || extra === main || /indicate|point it|target\s*:/i.test(extra)) return main;
  return `${main}\n\n${extra}`;
}

function canStartGuide(reply: {
  multi_step: boolean;
  target: unknown;
  dot: unknown;
  action: string;
  confidence: number;
}) {
  // A walkthrough must have a locally verifiable first target. If the model is
  // unsure, keep the safe single answer instead of starting a guide that can
  // neither point nor prove completion.
  const actions = new Set(["click", "type", "select", "toggle", "submit", "open"]);
  return (
    reply.multi_step &&
    reply.target !== null &&
    reply.dot !== null &&
    reply.confidence >= 0.65 &&
    actions.has(reply.action.trim().toLowerCase())
  );
}

function stripModelJunk(text: string) {
  return text
    .replace(/```json[\s\S]*?```/gi, "")
    .replace(/target\s*:\s*\{[\s\S]*\}/gi, "")
    .replace(/\{[^{}]*"label"\s*:[^{}]*\}/g, "")
    .replace(/click indicate[^\n]*/gi, "")
    .trim();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
