import { useEffect, useRef, useState } from "react";

import { BAND_COUNT, transcribeWav } from "@/lib/pointy";

const SILENT = Array<number>(BAND_COUNT).fill(0);
const TARGET_RATE = 16_000;
const MAX_SECONDS = 20;

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
 * Overlay-owned microphone: live levels, live speech-to-text, and a WAV of the hold
 * sent through NVIDIA Whisper when the browser recognizer is silent (WebView2).
 */
export function useOverlayVoice(active: boolean) {
  const [bands, setBands] = useState<number[]>(SILENT);
  const [level, setLevel] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  const transcriptRef = useRef("");
  const chunksRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef(TARGET_RATE);
  const flushRef = useRef<() => Promise<string>>(async () => "");

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => {
    if (!active) {
      setBands(SILENT);
      setLevel(0);
      return;
    }

    setTranscript("");
    transcriptRef.current = "";
    setError(null);
    chunksRef.current = [];

    let cancelled = false;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let processor: ScriptProcessorNode | null = null;
    let rec: SpeechRecognition | null = null;
    let raf = 0;

    (async () => {
      try {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 220));
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        audioCtx = new AudioContext();
        if (audioCtx.state === "suspended") await audioCtx.resume();
        sampleRateRef.current = audioCtx.sampleRate;
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0);
          chunksRef.current.push(new Float32Array(input));
          const maxSamples = sampleRateRef.current * MAX_SECONDS;
          let total = chunksRef.current.reduce((sum, chunk) => sum + chunk.length, 0);
          while (total > maxSamples && chunksRef.current.length > 1) {
            const dropped = chunksRef.current.shift();
            total -= dropped?.length ?? 0;
          }
        };
        source.connect(processor);
        // Keep the node in the graph without playing the mic through the speakers.
        const mute = audioCtx.createGain();
        mute.gain.value = 0;
        processor.connect(mute);
        mute.connect(audioCtx.destination);

        const freq = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          if (cancelled) return;
          analyser.getByteFrequencyData(freq);
          const slice = Math.max(1, Math.floor(freq.length / BAND_COUNT));
          const nextBands = Array.from({ length: BAND_COUNT }, (_, i) => {
            let sum = 0;
            for (let j = 0; j < slice; j++) sum += freq[i * slice + j] ?? 0;
            return sum / slice / 255;
          });
          setBands(nextBands);
          setLevel(nextBands.reduce((a, b) => a + b, 0) / BAND_COUNT);
          raf = requestAnimationFrame(tick);
        };
        tick();

        const Ctor = recognitionCtor();
        if (Ctor) {
          rec = new Ctor();
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = "en-US";
          rec.onresult = (event: SpeechRecognitionEvent) => {
            let text = "";
            for (let i = 0; i < event.results.length; i++) {
              text += event.results[i]?.[0]?.transcript ?? "";
            }
            const next = text.trim();
            transcriptRef.current = next;
            setTranscript(next);
          };
          rec.onerror = (event: SpeechRecognitionErrorEvent) => {
            if (event.error === "no-speech" || event.error === "aborted") return;
            setError(event.message || event.error);
          };
          try {
            rec.start();
            setSupported(true);
          } catch {
            setSupported(false);
          }
        } else {
          setSupported(false);
        }
      } catch (reason) {
        if (!cancelled) {
          setError(String(reason));
          setSupported(false);
        }
      }
    })();

    flushRef.current = async () => {
      rec?.stop();
      rec = null;
      processor?.disconnect();
      processor = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      if (audioCtx && audioCtx.state !== "closed") await audioCtx.close().catch(() => {});
      audioCtx = null;

      const live = transcriptRef.current.trim();
      if (live) return live;

      const pcm = concat(chunksRef.current);
      chunksRef.current = [];
      if (pcm.length < sampleRateRef.current * 0.25) return "";

      const wav = encodeWav(pcm, sampleRateRef.current, TARGET_RATE);
      try {
        const text = (await transcribeWav(bytesToBase64(wav))).trim();
        if (text) {
          transcriptRef.current = text;
          setTranscript(text);
        }
        return text;
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return "";
      }
    };

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      rec?.abort();
      processor?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      void audioCtx?.close();
    };
  }, [active]);

  return {
    bands,
    level,
    transcript,
    error,
    supported,
    flush: () => flushRef.current(),
  };
}

function concat(chunks: Float32Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function downsample(input: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j] ?? 0;
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function encodeWav(input: Float32Array, fromRate: number, toRate: number): Uint8Array {
  const samples = downsample(input, fromRate, toRate);
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, toRate, true);
  view.setUint32(28, toRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer));
  return new Uint8Array(buffer);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
