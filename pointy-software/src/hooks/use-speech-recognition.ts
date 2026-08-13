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
 */
export function useSpeechRecognition(listening: boolean) {
  const [committed, setCommitted] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const sessionRef = useRef("");

  useEffect(() => {
    if (!listening) {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      if (sessionRef.current.trim()) {
        setCommitted((prev) => (prev ? `${prev} ${sessionRef.current}` : sessionRef.current).trim());
        sessionRef.current = "";
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

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let interimText = "";
      let session = sessionRef.current;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript?.trim();
        if (!text) continue;
        if (result.isFinal) session = session ? `${session} ${text}` : text;
        else interimText += text;
      }

      sessionRef.current = session;
      setInterim([session, interimText].filter(Boolean).join(" ").trim());
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
    setError(null);
  };

  return { display, interim, committed, wordCount, error, supported, reset };
}
