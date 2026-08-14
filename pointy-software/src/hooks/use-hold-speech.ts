import { useEffect, useRef, useState } from "react";

type SpeechCtor = new () => SpeechRecognition;

function recognitionCtor(): SpeechCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: SpeechCtor;
    webkitSpeechRecognition?: SpeechCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Transcribe while the hotkey is held. Starts on `active`, freezes the last
 * transcript when it goes false so the processing beat can send it to the AI.
 */
export function useHoldSpeech(active: boolean) {
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const recRef = useRef<SpeechRecognition | null>(null);

  useEffect(() => {
    if (!active) {
      recRef.current?.stop();
      recRef.current = null;
      return;
    }

    setTranscript("");
    setError(null);

    const Ctor = recognitionCtor();
    if (!Ctor) {
      setSupported(false);
      return;
    }

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (event: SpeechRecognitionEvent) => {
      let text = "";
      for (let i = 0; i < event.results.length; i++) {
        text += event.results[i]?.[0]?.transcript ?? "";
      }
      setTranscript(text.trim());
    };
    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      setError(event.message || event.error);
    };

    try {
      rec.start();
      recRef.current = rec;
      setSupported(true);
    } catch (reason) {
      setError(String(reason));
      setSupported(false);
    }

    return () => {
      rec.stop();
      recRef.current = null;
    };
  }, [active]);

  return { transcript, error, supported };
}
