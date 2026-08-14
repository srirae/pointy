import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { AnimatePresence, motion } from "motion/react";

import { ClickHint } from "@/components/overlay/click-hint";
import { GuidePill, type GuidePhase } from "@/components/overlay/guide-pill";
import { useOverlayVoice } from "@/hooks/use-overlay-voice";
import {
  onHotkeyDown,
  onHotkeyUp,
  overlayHide,
  overlaySetHitRect,
  overlaySetPassthrough,
  wakeSetTranscript,
  type ClickTarget,
} from "@/lib/pointy";
import { askAboutScreen, waitForScreenshot } from "@/lib/screen-ask";

/**
 * Phase 3 + 4 overlay: hold to listen, release to ask NIM (screenshot + transcript),
 * Guide-Dot expands into a markdown answer. Empty speech falls back to typing.
 */
export function Overlay() {
  const [phase, setPhase] = useState<GuidePhase>("listening");
  const [leaving, setLeaving] = useState(false);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [target, setTarget] = useState<ClickTarget | null>(null);
  const [indicating, setIndicating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState(() => defaultPos());
  const pillRef = useRef<HTMLDivElement>(null);

  const listening = phase === "listening";
  const working = phase !== "listening";
  const voice = useOverlayVoice(listening);

  const holdGen = useRef(0);
  const queryRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const posRef = useRef(pos);
  const flushRef = useRef(voice.flush);
  flushRef.current = voice.flush;
  posRef.current = pos;

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    if (listening && voice.transcript) setQuery(voice.transcript);
  }, [listening, voice.transcript]);

  useEffect(() => {
    void overlaySetPassthrough(working && !leaving);
    return () => {
      if (!working) void overlaySetPassthrough(false);
    };
  }, [working, leaving]);

  useEffect(() => {
    if (!working || leaving) return;
    const node = pillRef.current;
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
  }, [working, leaving, phase, pos, answer, query]);

  const dismiss = useCallback(() => {
    if (phase === "listening") return;
    if (indicating) {
      setIndicating(false);
      return;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    setLeaving(true);
    window.setTimeout(() => {
      void overlayHide();
      setLeaving(false);
    }, 180);
  }, [phase, indicating]);

  const ask = useCallback(async (text: string, gen: number) => {
    const question = text.trim();
    if (!question) {
      setPhase("composing");
      return;
    }

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase("processing");
    setError(null);
    setAnswer("");
    setTarget(null);
    setIndicating(false);
    void wakeSetTranscript(question);

    try {
      const screenshot = await waitForScreenshot();
      if (holdGen.current !== gen || ctrl.signal.aborted) return;
      const reply = await askAboutScreen(question, screenshot, ctrl.signal);
      if (holdGen.current !== gen || ctrl.signal.aborted) return;
      const body = [reply.answer, reply.advice].filter(Boolean).join("\n\n");
      setAnswer(body);
      setTarget(reply.target ?? null);
      setPhase("answered");
    } catch (reason) {
      if (ctrl.signal.aborted || holdGen.current !== gen) return;
      const message =
        reason instanceof Error ? reason.message : "Couldn’t reach NVIDIA NIM. Try again.";
      setError(message);
      setPhase("composing");
    }
  }, []);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      const down = await onHotkeyDown(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        holdGen.current += 1;
        setLeaving(false);
        setQuery("");
        setAnswer("");
        setTarget(null);
        setIndicating(false);
        setError(null);
        setPhase("listening");
      });
      const up = await onHotkeyUp(() => {
        const gen = holdGen.current;
        void (async () => {
          setPhase("processing");
          const spoken = (await flushRef.current()) || queryRef.current.trim();
          if (holdGen.current !== gen) return;
          setQuery(spoken);
          queryRef.current = spoken;
          if (!spoken) {
            setPhase("composing");
            return;
          }
          await ask(spoken, gen);
        })();
      });

      if (cancelled) {
        down();
        up();
        return;
      }
      unlisteners.push(down, up);
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((off) => off());
      abortRef.current?.abort();
    };
  }, [ask]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

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
        x: clamp(event.clientX - dragRef.current.dx, 80, window.innerWidth - 80),
        y: clamp(event.clientY - dragRef.current.dy, 24, window.innerHeight - 80),
      });
    },
    onPointerUp: () => {
      dragRef.current = null;
    },
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-transparent">
      <AnimatePresence>
        {!leaving && listening && (
          <motion.button
            key="frost"
            type="button"
            aria-label="Dismiss Pointy"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0 cursor-default"
            style={{
              background: "rgba(12, 16, 20, 0.38)",
              backdropFilter: "blur(18px) saturate(140%)",
              WebkitBackdropFilter: "blur(18px) saturate(140%)",
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!leaving && indicating && target && (
          <motion.div
            key="hint"
            className="absolute inset-0 z-[5]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <ClickHint target={target} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!leaving && (
          <motion.div
            key="guide"
            className="pointer-events-auto absolute z-10"
            style={{ left: pos.x, top: pos.y }}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <div ref={pillRef} className="absolute top-0 left-0 -translate-x-1/2">
              <GuidePill
                phase={phase}
                query={query}
                onQueryChange={setQuery}
                onSubmit={() => void ask(query, holdGen.current)}
                answer={answer}
                error={error ?? (listening ? voice.error : null)}
                target={target}
                indicating={indicating}
                onIndicate={() => {
                  setIndicating((on) => {
                    if (on) return false;
                    if (target) {
                      const mid = (target.x + target.w / 2) * window.innerWidth;
                      setPos({
                        x:
                          mid > window.innerWidth / 2
                            ? window.innerWidth * 0.22
                            : window.innerWidth * 0.78,
                        y: Math.max(72, window.innerHeight * 0.58),
                      });
                    }
                    return true;
                  });
                }}
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
    x: window.innerWidth / 2,
    y: Math.max(80, window.innerHeight * 0.36),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
