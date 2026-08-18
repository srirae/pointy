import {
  useEffect,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Crosshair,
  Loader2,
  Mic,
  MicOff,
  Pencil,
  RotateCcw,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { motion } from "motion/react";

import { AnswerMarkdown } from "@/components/overlay/answer-markdown";
import { AppPicker } from "@/components/overlay/app-picker";
import { Thinking } from "@/components/overlay/thinking";
import { PointyMark } from "@/components/pointy-mark";
import type { AppWindow, ClickTarget, DotPoint, GuideStep } from "@/lib/pointy";

export type TurnStatus = "asking" | "done" | "stopped" | "error";

export type Turn = {
  id: number;
  question: string;
  answer: string;
  target: ClickTarget | null;
  /** Exact center dot from the accessibility tree, when resolved. */
  dot: DotPoint | null;
  status: TurnStatus;
  error: string | null;
};

const SPRING = { type: "spring", stiffness: 380, damping: 32 } as const;

/**
 * The glass panel: pick an app, then a running conversation about it.
 *
 * When a question is multi-step, a large walkthrough banner takes over the
 * space below the conversation: one instruction at a time, big and
 * high-contrast, with "Repeat that", "I'm stuck" and "Stop" always visible.
 */
export function AskWindow({
  picking,
  scope,
  scopeChosen,
  windows,
  windowsLoading,
  windowsError,
  onPick,
  onRefreshWindows,
  onChangeApp,
  turns,
  draft,
  onDraftChange,
  onSend,
  onStop,
  busy,
  listening,
  bands,
  onToggleMic,
  micError,
  onEdit,
  onRetry,
  pointedTurn,
  locatingTurn,
  onTogglePoint,
  copiedTurn,
  onCopy,
  speakingTurn,
  onListen,
  speakEnabled,
  onToggleSpeak,
  guideActive,
  guidePhase,
  guideStep,
  onRepeatGuide,
  onStopGuide,
  onClose,
  headerProps,
}: {
  picking: boolean;
  scope: AppWindow | null;
  scopeChosen: boolean;
  windows: AppWindow[];
  windowsLoading: boolean;
  windowsError: string | null;
  onPick: (window: AppWindow | null) => void;
  onRefreshWindows: () => void;
  onChangeApp: () => void;
  turns: Turn[];
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  listening: boolean;
  bands: number[];
  onToggleMic: () => void;
  micError: string | null;
  onEdit: (turn: Turn) => void;
  onRetry: (turn: Turn) => void;
  pointedTurn: number | null;
  /** Turn whose control is being re-found in the live UI tree right now. */
  locatingTurn: number | null;
  onTogglePoint: (turn: Turn) => void;
  copiedTurn: number | null;
  onCopy: (turn: Turn) => void;
  /** Turn currently being read aloud, if any. */
  speakingTurn: number | null;
  onListen: (turn: Turn) => void;
  speakEnabled: boolean;
  onToggleSpeak: () => void;
  guideActive: boolean;
  guidePhase: string;
  guideStep: GuideStep | null;
  onRepeatGuide: () => void;
  onStopGuide: () => void;
  onClose: () => void;
  headerProps?: HTMLAttributes<HTMLDivElement>;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canSend = scopeChosen && !busy && draft.trim().length > 0;

  useEffect(() => {
    if (scopeChosen && !picking) inputRef.current?.focus();
  }, [scopeChosen, picking]);

  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 104)}px`;
  }, [draft]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns, picking]);

  const send = () => {
    if (canSend) onSend();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const scopeName = scope ? scope.app : "This screen";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.98 }}
      transition={SPRING}
      className="flex w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-[1.35rem]"
      style={{
        background: "rgba(236, 239, 242, 0.9)",
        boxShadow: [
          "inset 0 1px 0 rgba(255, 255, 255, 0.85)",
          "0 26px 60px -22px rgba(46, 58, 71, 0.45)",
        ].join(", "),
        border: "1px solid rgba(255, 255, 255, 0.75)",
        backdropFilter: "blur(24px) saturate(165%)",
        WebkitBackdropFilter: "blur(24px) saturate(165%)",
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="flex cursor-grab items-center gap-2 px-3.5 pt-3 pb-2 active:cursor-grabbing"
        {...headerProps}
      >
        <PointyMark className="size-4 shrink-0" />
        <span className="text-[0.8125rem] font-semibold tracking-[-0.01em] text-[#2e3a47]">
          Pointy
        </span>

        {scopeChosen && (
          <button
            type="button"
            onClick={onChangeApp}
            onPointerDown={(event) => event.stopPropagation()}
            title="Work on a different app"
            className="ml-1 flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 transition-colors hover:bg-[#2e3a47]/8"
            style={{ background: "rgba(13,74,71,0.09)" }}
          >
            <span className="max-w-[7.5rem] truncate text-[0.6875rem] font-semibold text-[#0d4a47]">
              {scopeName}
            </span>
            <ChevronDown className="size-3 shrink-0 text-[#0d4a47]/70" />
          </button>
        )}

        <span className="flex-1" />

        <motion.span
          className="size-2 shrink-0 rounded-full"
          style={{ background: listening ? "#f5c518" : busy ? "#ffa61f" : "#0d4a47" }}
          animate={
            listening || busy
              ? { scale: [0.85, 1.2, 0.85], opacity: [0.6, 1, 0.6] }
              : { scale: 1, opacity: 1 }
          }
          transition={
            listening || busy
              ? { duration: 1.1, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.2 }
          }
        />
        <button
          type="button"
          onClick={onToggleSpeak}
          onPointerDown={(event) => event.stopPropagation()}
          aria-label={speakEnabled ? "Stop reading answers aloud" : "Read answers aloud automatically"}
          title={
            speakEnabled
              ? "Answers are read aloud automatically"
              : "Answers stay silent — use Listen on any answer"
          }
          className="flex size-5 shrink-0 items-center justify-center rounded-full text-[#6b7785] transition-colors hover:bg-[#2e3a47]/10 hover:text-[#2e3a47]"
        >
          {speakEnabled ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
        </button>
        <button
          type="button"
          onClick={onClose}
          onPointerDown={(event) => event.stopPropagation()}
          aria-label="Close Pointy"
          className="flex size-5 shrink-0 items-center justify-center rounded-full text-[#6b7785] transition-colors hover:bg-[#2e3a47]/10 hover:text-[#2e3a47]"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div
        ref={scrollRef}
        className="max-h-[16rem] overflow-y-auto overscroll-contain px-3.5 pb-2"
      >
        {picking ? (
          <AppPicker
            windows={windows}
            loading={windowsLoading}
            error={windowsError}
            onPick={onPick}
            onRefresh={onRefreshWindows}
          />
        ) : turns.length === 0 ? (
          <p className="pb-1 text-[0.8125rem] leading-relaxed text-[#6b7785]">
            {listening
              ? `Listening — tell me what you want to do in ${scopeName}.`
              : `Ask about ${scopeName}. Hold your hotkey to speak, or just type.`}
          </p>
        ) : (
          <div className="space-y-3 pb-1">
            {turns.map((turn) => (
              <TurnBlock
                key={turn.id}
                turn={turn}
                busy={busy}
                pointed={pointedTurn === turn.id}
                locating={locatingTurn === turn.id}
                copied={copiedTurn === turn.id}
                speaking={speakingTurn === turn.id}
                onEdit={onEdit}
                onRetry={onRetry}
                onTogglePoint={onTogglePoint}
                onCopy={onCopy}
                onListen={onListen}
              />
            ))}
          </div>
        )}
      </div>

      {micError && !picking && (
        <p className="px-3.5 pb-1 text-[0.6875rem] leading-relaxed text-[#b42318]">{micError}</p>
      )}

      {/* Guided walkthrough: one big, calm instruction at a time. */}
      {guideStep && (
        <div
          className="mx-3 mb-2 rounded-2xl px-4 py-3"
          style={{
            background: "rgba(255, 166, 31, 0.16)",
            border: "1.5px solid rgba(138, 82, 0, 0.4)",
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[0.75rem] font-bold tracking-[0.08em] text-[#8a5200] uppercase">
              Step {guideStep.step}
            </span>
            <span
              className="rounded-full px-2 py-0.5 text-[0.6875rem] font-bold"
              style={{ background: "rgba(13,74,71,0.12)", color: "#0d4a47" }}
            >
              {guideActive ? guidePhaseLabel(guidePhase) : "Done"}
            </span>
          </div>
          <p className="mt-1 text-[1.0625rem] font-semibold leading-snug text-[#2e3a47]">
            {guideStep.kind === "confirmed" ? "✓ " : ""}
            {guideStep.say}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onRepeatGuide}
              className="rounded-full px-3.5 py-2 text-[0.9375rem] font-bold text-[#2e3a47] transition-transform hover:scale-[1.03]"
              style={{ background: "rgba(255, 255, 255, 0.9)", boxShadow: "0 2px 8px -2px rgba(46,58,71,0.35)" }}
            >
              Repeat that
            </button>
            <button
              type="button"
              onClick={onStopGuide}
              className="rounded-full px-3 py-2 text-[0.875rem] font-bold text-[#8a5200] transition-colors hover:bg-[#ffa61f]/20"
            >
              Stop
            </button>
          </div>
        </div>
      )}

      <form
        className="px-3 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <div
          className="flex items-end gap-1.5 rounded-2xl px-2.5 py-2"
          style={{
            background: "rgba(255, 255, 255, 0.66)",
            boxShadow: listening
              ? "inset 0 0 0 1.5px rgba(255,166,31,0.55)"
              : "inset 0 0 0 1px rgba(255, 255, 255, 0.85)",
          }}
        >
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={!scopeChosen}
            rows={1}
            placeholder={
              !scopeChosen
                ? "Pick an app above to start"
                : listening
                  ? "Listening…"
                  : "Ask about this screen"
            }
            className="max-h-[6.5rem] min-h-[1.35rem] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-1 text-[0.8125rem] leading-5 break-words whitespace-pre-wrap text-[#2e3a47] outline-none placeholder:text-[#8b95a1] disabled:cursor-not-allowed"
            autoComplete="off"
            spellCheck={false}
          />

          {listening && <VoiceBars bands={bands} />}

          <button
            type="button"
            onClick={onToggleMic}
            disabled={!scopeChosen}
            aria-label={listening ? "Stop listening" : "Speak"}
            title={listening ? "Stop listening" : "Speak"}
            className="flex size-7 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-30"
            style={{
              background: listening ? "rgba(255,166,31,0.24)" : "rgba(46,58,71,0.08)",
              color: listening ? "#8a5200" : "#2e3a47",
            }}
          >
            {listening ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
          </button>

          {busy ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop"
              className="flex size-7 shrink-0 items-center justify-center rounded-full"
              style={{ background: "rgba(180,35,24,0.14)", color: "#8f2018" }}
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send"
              title="Send"
              className="flex size-7 shrink-0 items-center justify-center rounded-full transition-opacity disabled:opacity-35"
              style={{
                background: canSend
                  ? "linear-gradient(to top, #d9a865, #ffa61f)"
                  : "rgba(46, 58, 71, 0.12)",
                color: "#2e3a47",
              }}
            >
              <ArrowUp className="size-3.5 stroke-[2.5]" />
            </button>
          )}
        </div>
      </form>
    </motion.div>
  );
}

function TurnBlock({
  turn,
  busy,
  pointed,
  locating,
  copied,
  speaking,
  onEdit,
  onRetry,
  onTogglePoint,
  onCopy,
  onListen,
}: {
  turn: Turn;
  busy: boolean;
  pointed: boolean;
  locating: boolean;
  copied: boolean;
  speaking: boolean;
  onEdit: (turn: Turn) => void;
  onRetry: (turn: Turn) => void;
  onTogglePoint: (turn: Turn) => void;
  onCopy: (turn: Turn) => void;
  onListen: (turn: Turn) => void;
}) {
  const asking = turn.status === "asking";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="group"
    >
      <div className="flex items-start justify-end gap-1">
        {!asking && (
          <button
            type="button"
            onClick={() => onEdit(turn)}
            title="Edit and ask again"
            className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full text-[#6b7785] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[#2e3a47]/10 hover:text-[#2e3a47]"
          >
            <Pencil className="size-3" />
          </button>
        )}
        <p
          className="max-w-[85%] rounded-2xl rounded-br-md px-2.5 py-1.5 text-[0.8125rem] leading-snug break-words whitespace-pre-wrap"
          style={{ background: "rgba(13,74,71,0.1)", color: "#22343f" }}
        >
          {turn.question}
        </p>
      </div>

      <div className="mt-2">
        <p className="text-[0.625rem] font-semibold tracking-[0.14em] text-[#6b7785] uppercase">
          Pointy
        </p>
        <div className="mt-1">
          {asking ? (
            <Thinking />
          ) : turn.status === "error" ? (
            <p className="text-[0.8125rem] leading-relaxed break-words text-[#b42318]">
              {turn.error}
            </p>
          ) : turn.status === "stopped" ? (
            <p className="text-[0.8125rem] leading-relaxed text-[#6b7785]">
              Stopped before it finished.
            </p>
          ) : (
            <AnswerMarkdown text={turn.answer} tone="light" />
          )}
        </div>

        {!asking && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {turn.status === "done" && turn.target && (
              <button
                type="button"
                onClick={() => onTogglePoint(turn)}
                disabled={locating}
                title="Find this control on the screen as it looks right now"
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.75rem] font-semibold tracking-[-0.01em] disabled:opacity-70"
                style={{
                  background: pointed
                    ? "rgba(13,74,71,0.12)"
                    : "linear-gradient(to top, #d9a865, #ffa61f)",
                  color: pointed ? "#0d4a47" : "#2e3a47",
                }}
              >
                {locating ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Crosshair className="size-3" />
                )}
                {locating ? "finding it" : pointed ? "hide point" : "point it"}
              </button>
            )}
            {turn.status === "done" && turn.answer && (
              <button
                type="button"
                onClick={() => onListen(turn)}
                title={speaking ? "Stop reading" : "Read this answer aloud"}
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[0.75rem] font-semibold transition-colors ${
                  speaking
                    ? "bg-[#0d4a47]/10 text-[#0d4a47]"
                    : "text-[#6b7785] hover:bg-[#2e3a47]/8 hover:text-[#2e3a47]"
                }`}
              >
                {speaking ? (
                  <Square className="size-3 fill-current" />
                ) : (
                  <Volume2 className="size-3" />
                )}
                {speaking ? "Stop" : "Listen"}
              </button>
            )}
            <button
              type="button"
              onClick={() => onRetry(turn)}
              disabled={busy}
              title="Ask again with a fresh look at the screen"
              className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[0.75rem] font-semibold text-[#6b7785] transition-colors hover:bg-[#2e3a47]/8 hover:text-[#2e3a47] disabled:opacity-40"
            >
              <RotateCcw className="size-3" />
              Again
            </button>
            {turn.status === "done" && turn.answer && (
              <button
                type="button"
                onClick={() => onCopy(turn)}
                title="Copy answer"
                className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[0.75rem] font-semibold text-[#6b7785] transition-colors hover:bg-[#2e3a47]/8 hover:text-[#2e3a47]"
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copied ? "Copied" : "Copy"}
              </button>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function guidePhaseLabel(phase: string) {
  switch (phase) {
    case "requesting_next":
      return "Preparing next step";
    case "recovery":
      return "Still here with you";
    case "completed":
      return "Done";
    default:
      return "Guiding you";
  }
}

function VoiceBars({ bands }: { bands: number[] }) {
  return (
    <div className="mb-1.5 flex h-4 shrink-0 items-end gap-0.5">
      {[0, 1, 2, 3].map((i) => (
        <motion.span
          key={i}
          className="w-0.5 rounded-full bg-[#0d4a47]"
          animate={{ height: 3 + (bands[i] ?? bands[0] ?? 0) * 13 }}
          transition={{ type: "spring", stiffness: 420, damping: 28 }}
        />
      ))}
    </div>
  );
}
