import { useCallback, useEffect, useRef, useState } from "react";

import {
  audioSnapshotRecord,
  audioStartRecord,
  audioStopRecord,
  BAND_COUNT,
  onMicError,
  onMicLevel,
  onMicStopped,
  transcribeWav,
} from "@/lib/pointy";
import { isTauri } from "@/lib/tauri";

const SILENT = Array<number>(BAND_COUNT).fill(0);
/** How often the interim transcript re-transcribes the audio captured so far. */
const INTERIM_MS = 1500;

/**
 * Overlay-owned voice session, recorded by Rust.
 *
 * Rust owns the only microphone capture in the app (audio.rs). This hook never
 * opens the device itself: `audio_start_record` starts the shared session, the
 * band levels come from the same stream over `mic://level`, and the WAV for
 * Deepgram is read back with `audio_snapshot_record` (interim) / `audio_stop_record`
 * (final flush). Rust enforces a hard 30s cap and logs every open/close, so a
 * missed hotkey-up or a hung flush can never hold the device indefinitely.
 */
export function useOverlayVoice(active: boolean, generation = 0) {
  const [bands, setBands] = useState<number[]>(SILENT);
  const [level, setLevel] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  const transcriptRef = useRef("");
  const flushRef = useRef<() => Promise<string>>(async () => "");
  const flushingRef = useRef(false);
  const sessionRef = useRef(0);
  const finalizedRef = useRef(false);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  /** Forget the last error once the user moves on (typing or a fresh session). */
  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    if (!active) {
      sessionRef.current += 1;
      if (!flushingRef.current) {
        transcriptRef.current = "";
        setTranscript("");
        flushRef.current = async () => "";
      }
      finalizedRef.current = true;
      setBands(SILENT);
      setLevel(0);
      setError(null);
      // Safety: if a record session is somehow still open (e.g. the overlay
      // reloaded mid-hold), hand the device back. Idempotent in Rust.
      void audioStopRecord().catch(() => {});
      return;
    }

    const session = generation || ++sessionRef.current;
    sessionRef.current = session;
    setTranscript("");
    transcriptRef.current = "";
    setError(null);
    finalizedRef.current = false;

    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    let interimInFlight = false;

    (async () => {
      if (!isTauri()) {
        if (!cancelled) {
          setError("Voice needs the desktop app.");
          setSupported(false);
        }
        return;
      }
      try {
        await audioStartRecord();
        if (cancelled || sessionRef.current !== session) {
          await audioStopRecord().catch(() => {});
          return;
        }
        setSupported(true);
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setSupported(false);
        }
      }
    })();

    // Band levels come from the same Rust stream, so the bars move exactly in
    // sync with what is being recorded.
    void onMicLevel((next) => {
      if (!cancelled && sessionRef.current === session) {
        setBands(next.bands);
        setLevel(next.level);
      }
    }).then((off) => (cancelled ? off() : unlisteners.push(off)));

    void onMicError((reason) => {
      if (!cancelled) setError(reason);
    }).then((off) => (cancelled ? off() : unlisteners.push(off)));

    // The backend force-closed the dictation (hard cap); the final flush will
    // come back empty, so stop trying to read anything more.
    void onMicStopped(() => {
      if (sessionRef.current === session) finalizedRef.current = true;
    }).then((off) => (cancelled ? off() : unlisteners.push(off)));

    // Live interim transcription: re-transcribe the audio captured so far every
    // ~1.5s so the user sees their words appear while they are still speaking.
    // Failures stay quiet here; the final flush surfaces any real error.
    const interimTimer = window.setInterval(async () => {
      if (interimInFlight || cancelled || sessionRef.current !== session || finalizedRef.current) {
        return;
      }
      interimInFlight = true;
      try {
        const wav = await audioSnapshotRecord();
        if (!wav) return;
        const text = (await transcribeWav(wav)).trim();
        if (text && !cancelled && sessionRef.current === session && !finalizedRef.current) {
          transcriptRef.current = text;
          setTranscript(text);
        }
      } catch {
        // Interim transcription is best-effort.
      } finally {
        interimInFlight = false;
      }
    }, INTERIM_MS);

    flushRef.current = async () => {
      if (sessionRef.current !== session) return "";
      finalizedRef.current = true;
      flushingRef.current = true;
      try {
        const wav = await audioStopRecord();
        if (!wav) return "";
        const text = (await transcribeWav(wav)).trim();
        if (text && sessionRef.current === session) {
          transcriptRef.current = text;
          setTranscript(text);
        }
        return text;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return "";
      } finally {
        flushingRef.current = false;
      }
    };

    return () => {
      cancelled = true;
      window.clearInterval(interimTimer);
      unlisteners.forEach((off) => off());
      // The final flush owns the close; only release here if the session ended
      // some other way (webview reload / hide) and Rust still has the device.
      if (!flushingRef.current && !finalizedRef.current) void audioStopRecord().catch(() => {});
    };
  }, [active, generation]);

  return {
    bands,
    level,
    transcript,
    error,
    supported,
    clearError,
    flush: () => flushRef.current(),
  };
}
