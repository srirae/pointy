import { useCallback, useEffect, useRef, useState } from "react";

import { isTauri } from "@/lib/tauri";
import {
  hotkeyStartCapture,
  hotkeyStopCapture,
  onCaptureComplete,
  onCaptureProgress,
  onHookFailed,
  onHotkeyDown,
  onHotkeyUp,
  type Combo,
  type Validation,
} from "@/lib/pointy";

const MODIFIERS = new Set(["Ctrl", "Alt", "Shift", "Win"]);

function canonical(keys: string[]): string[] {
  const unique = [...new Set(keys)];
  const order = ["Ctrl", "Alt", "Shift", "Win"];
  return unique.sort((a, b) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

function validate(keys: string[]): Validation {
  const combo = { keys: canonical(keys) };
  const modifiers = combo.keys.filter((k) => MODIFIERS.has(k)).length;
  const plain = combo.keys.length - modifiers;

  let reason: string | null = null;
  if (combo.keys.length === 0) reason = "Press the keys you want to use.";
  else if (modifiers === 0) reason = "Add a modifier — Ctrl, Alt, Shift or Win.";
  else if (plain > 1) reason = "Use one regular key at most, plus modifiers.";
  else if (plain === 0 && modifiers < 2) {
    reason = "A single modifier fires too easily. Use two modifiers, or add a key.";
  }

  return { valid: reason === null, reason, combo };
}

function tokenFromKeyboardEvent(event: KeyboardEvent): string | null {
  if (event.key === "Control" || event.code === "ControlLeft" || event.code === "ControlRight") {
    return "Ctrl";
  }
  if (event.key === "Alt" || event.code.startsWith("Alt")) return "Alt";
  if (event.key === "Shift" || event.code.startsWith("Shift")) return "Shift";
  if (event.key === "Meta" || event.code.startsWith("Meta")) return "Win";
  if (event.key === " ") return "Space";
  if (event.key === "Escape") return "Escape";
  if (event.key === "Enter") return "Enter";
  if (event.key === "Tab") return "Tab";
  if (event.key.length === 1) return event.key.toUpperCase();
  if (/^F\d+$/.test(event.key)) return event.key;
  return null;
}

/**
 * Drives the "record your hotkey" step. The keyboard hook lives in Rust; this hook
 * only mirrors what it reports — keys as they go down, and the finished combo when the
 * user lets go.
 */
export function useHotkeyCapture() {
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [pressed, setPressed] = useState<string[]>([]);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [captured, setCaptured] = useState<Combo | null>(null);
  const [hookError, setHookError] = useState<string | null>(null);
  const previewHeld = useRef(new Set<string>());
  const previewBest = useRef<string[]>([]);

  // Register Rust event listeners BEFORE capture starts — otherwise early key presses are lost.
  useEffect(() => {
    if (!isTauri()) {
      setReady(true);
      return;
    }

    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      try {
        const progress = await onCaptureProgress((update) => {
          setPressed(update.keys);
          setValidation(update.validation);
        });
        const complete = await onCaptureComplete((update) => {
          setPressed(update.keys);
          setValidation(update.validation);
          if (update.validation.valid) {
            setCaptured(update.validation.combo);
            setRecording(false);
          }
        });
        const failed = await onHookFailed(setHookError);

        if (cancelled) {
          progress();
          complete();
          failed();
          return;
        }
        unlisteners.push(progress, complete, failed);
        setReady(true);
      } catch (reason) {
        if (!cancelled) {
          setHookError(String(reason));
          setReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      setReady(false);
      unlisteners.forEach((off) => off());
      void hotkeyStopCapture();
    };
  }, []);

  const start = useCallback(async () => {
    setPressed([]);
    setValidation(null);
    setCaptured(null);
    setHookError(null);
    setRecording(true);
    previewHeld.current.clear();
    previewBest.current = [];
    await hotkeyStartCapture();
  }, []);

  const cancel = useCallback(async () => {
    setRecording(false);
    setPressed([]);
    setValidation(null);
    previewHeld.current.clear();
    previewBest.current = [];
    await hotkeyStopCapture();
  }, []);

  // Browser preview: local keyboard capture when Rust isn't available.
  useEffect(() => {
    if (isTauri() || !recording || captured) return;

    const onDown = (event: KeyboardEvent) => {
      event.preventDefault();
      const token = tokenFromKeyboardEvent(event);
      if (!token || previewHeld.current.has(token)) return;

      previewHeld.current.add(token);
      const next = canonical([...previewHeld.current]);
      if (next.length >= previewBest.current.length) previewBest.current = next;
      setPressed(next);
      setValidation(validate(next));
    };

    const onUp = (event: KeyboardEvent) => {
      event.preventDefault();
      const token = tokenFromKeyboardEvent(event);
      if (!token) return;

      previewHeld.current.delete(token);
      if (previewHeld.current.size > 0) {
        const next = canonical([...previewHeld.current]);
        setPressed(next);
        setValidation(validate(next));
        return;
      }

      const keys = previewBest.current.length > 0 ? previewBest.current : canonical([token]);
      const result = validate(keys);
      setPressed(keys);
      setValidation(result);
      if (result.valid) {
        setCaptured(result.combo);
        setRecording(false);
      }
    };

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [recording, captured]);

  return { ready, recording, pressed, validation, captured, hookError, start, cancel, setCaptured };
}

/**
 * Push-to-talk edges for the armed hotkey: `held` is true between key-down and key-up,
 * and `pressCount` increments once per completed press.
 */
export function useHotkeyPress(active: boolean) {
  const [held, setHeld] = useState(false);
  const [pressCount, setPressCount] = useState(0);
  const heldRef = useRef(false);

  useEffect(() => {
    if (!active) return;
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      const down = await onHotkeyDown(() => {
        heldRef.current = true;
        setHeld(true);
      });
      const up = await onHotkeyUp(() => {
        if (!heldRef.current) return;
        heldRef.current = false;
        setHeld(false);
        setPressCount((count) => count + 1);
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
    };
  }, [active]);

  return { held, pressCount };
}
