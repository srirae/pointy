import { useEffect, useRef, useState } from "react";
import { Check, Globe } from "lucide-react";

import type { Language } from "@/lib/pointy";

/**
 * Picks the language the user speaks in.
 *
 * Understanding a language needs nothing local — Whisper translates it to
 * English in the cloud — but speaking it back needs a downloaded voice. So a
 * language with no voice yet is still selectable, and simply says that answers
 * will be read in English until the voice is fetched from Settings.
 */
export function LanguagePicker({
  languages,
  value,
  installed,
  onChange,
  onOpenChange,
}: {
  languages: Language[];
  value: string;
  installed: Record<string, boolean>;
  onChange: (code: string) => void;
  /** The dropdown overflows the card, so the overlay must stay clickable while it is open. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [open]);

  const current = languages.find((language) => language.code === value);
  if (languages.length < 2) return null;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        onPointerDown={(event) => event.stopPropagation()}
        aria-label={`Speaking ${current?.english ?? "English"} — change language`}
        title={`Speaking ${current?.english ?? "English"}`}
        className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.6875rem] font-semibold uppercase text-[#6b7785] transition-colors hover:bg-[#2e3a47]/10 hover:text-[#2e3a47]"
      >
        <Globe className="size-3.5" />
        {current?.code ?? "en"}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-30 mt-1.5 w-52 overflow-hidden rounded-xl py-1 shadow-[0_18px_44px_-18px_rgba(46,58,71,0.5)]"
          style={{
            background: "rgba(248, 250, 251, 0.97)",
            border: "1px solid rgba(255,255,255,0.8)",
            backdropFilter: "blur(20px) saturate(160%)",
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <p className="px-3 py-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-[#95a0ab]">
            I speak
          </p>
          {languages.map((language) => {
            const chosen = language.code === value;
            const silent = Boolean(language.voice) && !installed[language.code];
            return (
              <button
                key={language.code}
                type="button"
                onClick={() => {
                  onChange(language.code);
                  setOpen(false);
                }}
                className={`flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[#2e3a47]/6 ${
                  chosen ? "text-[#0d4a47]" : "text-[#2e3a47]"
                }`}
              >
                <Check
                  className={`mt-0.5 size-3.5 shrink-0 ${chosen ? "opacity-100" : "opacity-0"}`}
                />
                <span className="min-w-0">
                  <span className="block text-[0.8125rem] font-semibold leading-tight">
                    {language.native}
                  </span>
                  <span className="block text-[0.6875rem] leading-tight text-[#6b7785]">
                    {silent ? "Answers read in English" : language.english}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
