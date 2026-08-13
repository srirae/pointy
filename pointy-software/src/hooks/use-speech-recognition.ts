import { useEffect, useRef, useState } from "react";

type SpeechRecognitionCtor = new () => SpeechRecognition;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Browser speech-to-text while `listening` is true (tie to hotkey hold).
 * Shows interim + committed text so the user can judge mic accuracy.
 *
 * Hold-to-talk handling: releasing the hotkey stops recognition immediately,
 * and the browser may never emit a *final* result for the last words you said.
 * To keep the transcript honest we mirror the latest interim text in a ref and
 * flush it — finals first, interim as a fallback — the moment the hold ends.
 * Otherwise short phrases (“where do I click”) come back empty and long ones
 * lose their tail, which reads as “speech recognition doesn’t work”.
 */
export function useSpeechRecognition(listening: boolean) {
  const [committed, setCommitted] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const sessionRef = useRef(""); // final results for the current hold
  const interimRef = useRef(""); // latest non-final words for the current hold

  const flushHold = () => {
    const finalText = sessionRef.current.trim();
    const interimText = interimRef.current.trim();
    sessionRef.current = "";
    interimRef.current = "";
    const text = [finalText, interimText].filter(Boolean).join(" ");
    if (!text) return;
    setCommitted((prev) => (prev ? `${prev} ${text}` : text).trim());
  };

  useEffect(() => {
    if (!listening) {
      const recognition = recognitionRef.current;
      recognitionRef.current = null;

      if (recognition) {
        // stop() can still deliver a final result for the tail of the utterance,
        // so flush now, then flush again in onend once those late results land.
        recognition.stop();
        flushHold();
      } else {
        flushHold();
      }
      setInterim("");
      return;
    }

    const SpeechRecognition = getSpeechRecognition();
    if (!SpeechRecognition) {
      setSupported(false);
      setError("Speech recognition is not available in this environment.");
      return;
    }

    setSupported(true);
    setError(null);
    sessionRef.current = "";
    interimRef.current = "";

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let finalText = sessionRef.current;
      let interimText = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript?.trim();
        if (!text) continue;
        if (result.isFinal) finalText = finalText ? `${finalText} ${text}` : text;
        else interimText += text;
      }

      sessionRef.current = finalText;
      interimRef.current = interimText;
      setInterim([finalText, interimText].filter(Boolean).join(" ").trim());
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      setError(`Speech recognition: ${event.error}`);
    };

    recognition.onend = () => {
      if (listening && recognitionRef.current === recognition) {
        try {
          recognition.start();
        } catch {
          /* restart after auto-stop */
        }
      } else {
        // Hold released (or recognition stopped for another reason) — commit any
        // words that landed between stop() and now.
        flushHold();
        setInterim("");
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
    } catch (reason) {
      setError(String(reason));
    }

    return () => {
      recognition.stop();
      if (recognitionRef.current === recognition) recognitionRef.current = null;
    };
  }, [listening]);

  const display = [committed, interim].filter(Boolean).join(" ").trim();
  const wordCount = display.split(/\s+/).filter(Boolean).length;

  const reset = () => {
    setCommitted("");
    setInterim("");
    sessionRef.current = "";
    interimRef.current = "";
    setError(null);
  };

  return { display, interim, committed, wordCount, error, supported, reset };
}
