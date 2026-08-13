import { useEffect, useState } from "react";

import { Pill, type PillState } from "@/components/overlay/pill";
import { useMicLevels } from "@/hooks/use-mic-levels";
import { onHotkeyDown, onHotkeyUp } from "@/lib/pointy";

/**
 * The floating pill window.
 *
 * The window itself is shown and hidden by Rust — it appears once onboarding is complete
 * and then stays up, idle and click-through, like any other system overlay (see
 * `src-tauri/src/overlay.rs`). What changes here is only the pill's state, so every
 * transition is a layout animation inside a canvas that never moves.
 *
 * The pill follows the hotkey directly: down opens it, up closes it. There is no
 * post-release state because nothing happens after the release yet — when a recogniser
 * lands, this is where its phase belongs.
 */
export function Overlay() {
  const [phase, setPhase] = useState<PillState>("idle");
  // The microphone opens for exactly as long as the hotkey is held, and never while the
  // pill is idle.
  const { bands, level, error: micError } = useMicLevels(phase === "listening");

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;

    (async () => {
      const down = await onHotkeyDown(() => setPhase("listening"));
      const up = await onHotkeyUp(() => setPhase("idle"));

      if (cancelled) {
        down();
        up();
        return;
      }
      unlisteners.push(down, up);
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((off) => off());
    };
  }, []);

  return (
    <div className="flex h-screen w-screen items-end justify-center pb-16 overflow-hidden bg-transparent">
      <Pill
        state={phase}
        bands={bands}
        level={level}
        error={phase === "idle" ? null : micError}
      />
    </div>
  );
}
