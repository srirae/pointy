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
  overlaySetPassthrough,
  wakeSetTranscript,
  windowsList,
  type AppWindow,
} from "@/lib/pointy";
import { askAboutScreen, grabScreen, targetToScreen } from "@/lib/screen-ask";

/**
 * The overlay session.
 *
 * Wake picks an app, then questions about that app accumulate as a conversation.
 * The mic only ever opens while `listening` is true, which needs a deliberate
 * hotkey hold or mic tap — the webview is mounted for the whole process life, so
 * anything else would record the room in the background.
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
  const [pointedTurn, setPointedTurn] = useState<number | null>(null);
  const [copiedTurn, setCopiedTurn] = useState<number | null>(null);
  const [pos, setPos] = useState(() => defaultPos());

  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turnSeq = useRef(0);
  /** False once the user types, so speech stops overwriting their edits. */
  const dictating = useRef(false);

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
  });
  live.current = { open, picking, listening, scopeChosen, scope, busy, draft };

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
    setOpen(false);
    setLeaving(false);
    setPicking(false);
    setScope(null);
    setScopeChosen(false);
    setTurns([]);
    setDraft("");
    setListening(false);
    setPointedTurn(null);
    setWindows([]);
  }, []);

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
      const shot = await grabScreen(app?.id ?? null);
      if (ctrl.signal.aborted) return;
      const reply = await askAboutScreen(
        question,
        shot.image || null,
        app?.app ?? null,
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      settle({
        status: "done",
        answer: visibleAnswer(reply.answer, reply.advice),
        target: reply.target ? targetToScreen(reply.target, shot) : null,
        error: null,
      });
    } catch (reason) {
      if (ctrl.signal.aborted) return;
      settle({
        status: "error",
        error:
          reason instanceof Error ? reason.message : "Couldn’t reach NVIDIA NIM. Try again.",
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
    setPointedTurn(null);
    setTurns((current) => [
      ...current,
      { id, question, answer: "", target: null, status: "asking", error: null },
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
    setPointedTurn((current) => (current === turn.id ? null : current));
    setDraft(turn.question);
  }, []);

  const retry = useCallback(
    (turn: Turn) => {
      if (live.current.busy) return;
      setPointedTurn((current) => (current === turn.id ? null : current));
      setTurns((current) =>
        current.map((kept) =>
          kept.id === turn.id
            ? { ...kept, status: "asking", answer: "", target: null, error: null }
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
    setPointedTurn(null);
    loadWindows();
  }, [loadWindows, stopListening]);

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
      setPointedTurn(null);
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
      if (pointedTurn !== null) {
        setPointedTurn(null);
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
  }, [busy, close, pointedTurn, stop]);

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

  const pointed = turns.find((turn) => turn.id === pointedTurn) ?? null;

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
        {!leaving && pointed?.target && (
          <motion.div
            key="hint"
            className="absolute inset-0 z-[5]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <ClickHint target={pointed.target} />
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
                pointedTurn={pointedTurn}
                onTogglePoint={(turn) =>
                  setPointedTurn((current) => (current === turn.id ? null : turn.id))
                }
                copiedTurn={copiedTurn}
                onCopy={copy}
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

/** Keep model plumbing — JSON, coordinate dumps — out of the glass. */
function visibleAnswer(answer: string, advice: string) {
  const main = stripModelJunk(answer);
  const extra = stripModelJunk(advice);
  if (!extra || extra === main || /indicate|point it|target\s*:/i.test(extra)) return main;
  return `${main}\n\n${extra}`;
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
