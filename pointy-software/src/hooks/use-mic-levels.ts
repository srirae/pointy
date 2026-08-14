import { useEffect, useRef, useState } from "react";

import { isTauri } from "@/lib/tauri";
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
 * Subscribe to live input levels from Rust (Tauri) or Web Audio (browser preview).
 *
 * `listenOnly` subscribes to `mic://level` without opening a second capture stream —
 * used by the overlay and dashboard when Rust already starts the mic on hotkey down.
 */
export function useMicLevels(
  enabled: boolean,
  device?: string | null,
  listenOnly = false,
) {
  const [bands, setBands] = useState<number[]>(SILENT);
  const [level, setLevel] = useState(0);
  const [openedDevice, setOpenedDevice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peak, setPeak] = useState(0);
  const peakRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setBands(SILENT);
      setLevel(0);
      setPeak(0);
      peakRef.current = 0;
      return;
    }

    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    let raf = 0;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;

    const pushLevel = (nextLevel: number, nextBands: number[]) => {
      setBands(nextBands);
      setLevel(nextLevel);
      peakRef.current = Math.max(peakRef.current, nextLevel);
      setPeak(peakRef.current);
    };

    (async () => {
      if (isTauri()) {
        try {
          unlisteners.push(
            await onMicLevel((next: MicLevel) => {
              pushLevel(next.level, next.bands);
            }),
          );
          unlisteners.push(await onMicError(setError));

          if (listenOnly) {
            setError(null);
            return;
          }

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
        return;
      }

      // Browser preview — Web Audio so the mic showcase still moves.
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError("Microphone needs the desktop app or a browser with mic access.");
          return;
        }
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        setOpenedDevice(device ?? "Browser microphone");
        setError(null);

        const tick = () => {
          if (cancelled) return;
          analyser.getByteFrequencyData(data);
          const slice = Math.floor(data.length / BAND_COUNT);
          const nextBands = Array.from({ length: BAND_COUNT }, (_, i) => {
            const start = i * slice;
            const end = start + slice;
            let sum = 0;
            for (let j = start; j < end; j++) sum += data[j] ?? 0;
            return sum / slice / 255;
          });
          const nextLevel = nextBands.reduce((a, b) => a + b, 0) / BAND_COUNT;
          pushLevel(nextLevel, nextBands);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        if (!cancelled) setError("Could not open the microphone. Check browser permissions.");
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((off) => off());
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void audioCtx?.close();
      if (isTauri() && !listenOnly) void audioStopLevels();
    };
  }, [enabled, device, listenOnly]);

  return { bands, level, peak, openedDevice, error };
}
