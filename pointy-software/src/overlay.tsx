import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { VoiceVisualizer } from "./components/overlay/voice-visualizer";
import { useMicLevels } from "./hooks/use-mic-levels";
import { useSpeechRecognition } from "./hooks/use-speech-recognition";

type State = "idle" | "listening" | "processing";

export function Overlay() {
  const [state, setState] = useState<State>("idle");
  const { bands } = useMicLevels(state === "listening");
  const { wordCount, reset } = useSpeechRecognition(state === "listening");

  useEffect(() => {
    // We add a tiny delay before capturing to avoid capturing the keypress sound if any
    const unlistenDown = listen("hotkey://down", () => {
      setState("listening");
      reset();
    });
    const unlistenUp = listen("hotkey://up", () => {
      setState("processing");
      // Simulate processing time before hiding
      setTimeout(async () => {
        setState("idle");
        await getCurrentWindow().hide();
      }, 1500);
    });

    return () => {
      unlistenDown.then((f) => f());
      unlistenUp.then((f) => f());
    };
  }, [reset]);

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent overflow-hidden">
      <div className="pointer-events-none rounded-full bg-card/90 backdrop-blur-xl shadow-[0_0_0_1px_rgba(46,58,71,0.08),0_20px_50px_-20px_rgba(13,74,71,0.45)] px-8 py-4 border border-border/50">
        <VoiceVisualizer state={state} bands={bands} wordCount={wordCount} />
      </div>
    </div>
  );
}
