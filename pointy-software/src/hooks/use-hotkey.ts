import { useCallback, useEffect, useRef, useState } from "react";

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

/**
 * Drives the "record your hotkey" step. The keyboard hook lives in Rust; this hook
 * only mirrors what it reports — keys as they go down, and the finished combo when the
 * user lets go.
 */
export function useHotkeyCapture() {
  const [recording, setRecording] = useState(false);
  const [pressed, setPressed] = useState<string[]>([]);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [captured, setCaptured] = useState<Combo | null>(null);
  const [hookError, setHookError] = useState<string | null>(null);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    (async () => {
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
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((off) => off());
      void hotkeyStopCapture();
    };
  }, []);

  const start = useCallback(async () => {
    setPressed([]);
    setValidation(null);
    setCaptured(null);
    setRecording(true);
    await hotkeyStartCapture();
  }, []);

  const cancel = useCallback(async () => {
    setRecording(false);
    setPressed([]);
    setValidation(null);
    await hotkeyStopCapture();
  }, []);

  return { recording, pressed, validation, captured, hookError, start, cancel, setCaptured };
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
