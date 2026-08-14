import { cn } from "@/lib/utils";

import { HotkeyCombo } from "@/components/hotkey-combo";

/** Focusable capture field — looks like an input, reads key combos from the Rust hook. */
export function HotkeyCaptureInput({
  keys,
  listening,
  ready,
  className,
}: {
  keys: string[];
  listening: boolean;
  ready: boolean;
  className?: string;
}) {
  const empty = keys.length === 0;
  const placeholder = !ready
    ? "Preparing keyboard…"
    : listening
      ? "Press your key combination…"
      : "Click here, then press your keys";

  return (
    <div
      role="textbox"
      tabIndex={0}
      aria-label="Hotkey combination"
      aria-readonly
      className={cn(
        "flex min-h-[4rem] w-full items-center justify-center rounded-xl border-2 px-4 py-3.5 transition-all duration-300 outline-none",
        empty
          ? "border-dashed border-border/70 bg-secondary/35"
          : "border-solid border-forest/35 bg-card shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]",
        listening && "border-forest/50 ring-2 ring-forest/15",
        className,
      )}
    >
      {empty ? (
        <span className="text-sm text-muted-foreground">{placeholder}</span>
      ) : (
        <HotkeyCombo keys={keys} size="lg" active={listening} />
      )}
    </div>
  );
}
