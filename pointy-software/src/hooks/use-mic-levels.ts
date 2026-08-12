import { useEffect, useState } from "react";

import {
  BAND_COUNT,
  audioStartLevels,
  audioStopLevels,
  onMicError,
  onMicLevel,
  type MicLevel,
} from "@/lib/pointy";

const SILENT = Array<number>(BAND_COUNT).fill(0);

/**
 * Subscribe to live input levels from the Rust capture thread. The stream starts when
 * `enabled` turns true and stops on unmount, so the microphone is only open while a
 * screen is actually showing it.
 */
export function useMicLevels(enabled: boolean, device?: string | null) {
  const [bands, setBands] = useState<number[]>(SILENT);
  const [level, setLevel] = useState(0);
  const [openedDevice, setOpenedDevice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peak, setPeak] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setBands(SILENT);
      setLevel(0);
      setPeak(0);
      return;
    }

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    (async () => {
      try {
        unlisteners.push(
          await onMicLevel((next: MicLevel) => {
            setBands(next.bands);
            setLevel(next.level);
            setPeak((current) => Math.max(current, next.level));
          }),
        );
        unlisteners.push(await onMicError(setError));

        const opened = await audioStartLevels(device);
        if (cancelled) {
          await audioStopLevels();
          return;
        }
        setOpenedDevice(opened);
        setError(null);
      } catch (reason) {
        if (!cancelled) setError(String(reason));
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((off) => off());
      void audioStopLevels();
    };
  }, [enabled, device]);

  return { bands, level, peak, openedDevice, error };
}
