import { Monitor, RotateCcw } from "lucide-react";
import { motion } from "motion/react";

import type { AppWindow } from "@/lib/pointy";

/**
 * First step after waking: which app is the question about?
 *
 * These are the user's real open windows rather than a guess from the pixels —
 * picking one both scopes the screenshot and tells the model what it is looking at.
 */
export function AppPicker({
  windows,
  loading,
  error,
  onPick,
  onRefresh,
}: {
  windows: AppWindow[];
  loading: boolean;
  error: string | null;
  onPick: (window: AppWindow | null) => void;
  onRefresh: () => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[0.625rem] font-semibold tracking-[0.14em] text-[#6b7785] uppercase">
          Work on
        </p>
        <button
          type="button"
          onClick={onRefresh}
          className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.625rem] font-semibold text-[#6b7785] transition-colors hover:bg-[#2e3a47]/6 hover:text-[#2e3a47]"
        >
          <RotateCcw className="size-2.5" />
          Refresh
        </button>
      </div>

      {error && <p className="mt-2 text-xs leading-relaxed text-[#b42318]">{error}</p>}

      <div className="mt-2 space-y-1">
        {loading && windows.length === 0
          ? [0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[2.6rem] animate-pulse rounded-xl"
                style={{
                  background: "rgba(255,255,255,0.5)",
                  animationDelay: `${i * 90}ms`,
                }}
              />
            ))
          : windows.map((win, i) => (
              <motion.button
                key={`${win.id}-${win.title}`}
                type="button"
                onClick={() => onPick(win)}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.035, duration: 0.18 }}
                className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/75"
                style={{ background: "rgba(255,255,255,0.5)" }}
              >
                <span
                  className="flex size-6 shrink-0 items-center justify-center rounded-lg text-[0.6875rem] font-bold text-white"
                  style={{ background: "linear-gradient(to top, #0d4a47, #17706b)" }}
                >
                  {initial(win.app)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.8125rem] font-semibold tracking-[-0.01em] text-[#2e3a47]">
                    {win.app}
                  </span>
                  <span className="block truncate text-[0.6875rem] text-[#6b7785]">
                    {win.title}
                  </span>
                </span>
                {win.focused && (
                  <span
                    className="shrink-0 rounded-full px-1.5 py-0.5 text-[0.5625rem] font-bold tracking-[0.06em] uppercase"
                    style={{ background: "rgba(255,166,31,0.22)", color: "#8a5200" }}
                  >
                    Front
                  </span>
                )}
              </motion.button>
            ))}

        <button
          type="button"
          onClick={() => onPick(null)}
          className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/75"
          style={{ background: "rgba(255,255,255,0.5)" }}
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-[#2e3a47]/10">
            <Monitor className="size-3.5 text-[#2e3a47]" />
          </span>
          <span className="text-[0.8125rem] font-semibold tracking-[-0.01em] text-[#2e3a47]">
            This whole screen
          </span>
        </button>
      </div>
    </div>
  );
}

function initial(name: string) {
  const letter = name.trim().charAt(0).toUpperCase();
  return letter || "?";
}
