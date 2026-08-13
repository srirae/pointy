import { motion } from "motion/react";
import { Loader2 } from "lucide-react";

const BAR_COUNT = 32;

export function VoiceVisualizer({
  state,
  bands,
}: {
  state: "idle" | "listening" | "processing";
  bands: number[];
  wordCount: number;
}) {
  return (
    <div className="flex flex-col items-center justify-center w-64 h-16 relative">
      {state === "listening" ? (
        <div className="flex items-center justify-center gap-1 h-full w-full">
          {Array.from({ length: BAR_COUNT }).map((_, i) => {
            const bandIndex = Math.floor((i / BAR_COUNT) * bands.length);
            const band = bands[bandIndex] ?? 0;
            const height = 4 + band * 48; // minimum 4px, max ~52px
            return (
              <motion.div
                key={i}
                className="w-1 rounded-full bg-gradient-to-t from-signal via-ochre to-forest"
                style={{ height }}
                animate={{ height, opacity: 0.6 + band * 0.4 }}
                transition={{ type: "spring", stiffness: 400, damping: 24 }}
              />
            );
          })}
        </div>
      ) : state === "processing" ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center justify-center gap-2"
        >
          <Loader2 className="size-6 animate-spin text-signal" />
          <span className="text-xs font-medium text-muted-foreground tracking-wide uppercase">
            Processing
          </span>
        </motion.div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="w-full h-1 bg-border rounded-full opacity-30"
        />
      )}
    </div>
  );
}
