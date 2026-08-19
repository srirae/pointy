import { useCallback, useEffect, useState } from "react";
import { Check, Download, Languages, Loader2 } from "lucide-react";
import { motion } from "motion/react";

import { Button } from "@/components/ui/button";
import {
  languages as listLanguages,
  onVoiceProgress,
  voiceDownload,
  voiceStatus,
  type Language,
} from "@/lib/pointy";

/**
 * Manages the downloadable voices.
 *
 * Speaking another language works the moment it is picked — Whisper translates
 * it to English in the cloud. Hearing an answer back in that language is what
 * needs a local voice, and each one is a sizeable download, so they are fetched
 * only when asked for here.
 */
export function VoiceLanguages() {
  const [languages, setLanguages] = useState<Language[]>([]);
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const status = await voiceStatus().catch(() => []);
    setInstalled(Object.fromEntries(status));
  }, []);

  useEffect(() => {
    void listLanguages().then(setLanguages).catch(() => {});
    void refresh();

    let off: (() => void) | null = null;
    let cancelled = false;
    void onVoiceProgress((progress) => {
      const code = progress.asset;
      setBusy((was) => ({ ...was, [code]: progress.phase === "downloading" }));
      setErrors((was) => ({ ...was, [code]: progress.error ?? "" }));
      if (progress.phase !== "downloading") void refresh();
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else off = unlisten;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [refresh]);

  const downloadable = languages.filter((language) => language.voice);
  if (downloadable.length === 0) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.18 }}
      className="mt-5 rounded-2xl border border-border/60 bg-card/90 p-6 shadow-[0_22px_48px_-28px_rgba(46,58,71,0.28)]"
    >
      <div className="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        <Languages className="size-3.5" aria-hidden />
        Speech languages
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Pointy understands Spanish, Hindi and Urdu straight away and answers in English.
        Download a voice to have those answers read back to you in that language too.
      </p>

      <ul className="mt-5 flex flex-col gap-2">
        {downloadable.map((language) => {
          const ready = installed[language.code];
          const downloading = busy[language.code];
          const error = errors[language.code];
          return (
            <li
              key={language.code}
              className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-secondary/40 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {language.native}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {language.english}
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {error
                    ? error
                    : ready
                      ? "Voice ready"
                      : downloading
                        ? "Downloading the voice — this takes a minute"
                        : "Around 60 MB, downloaded once"}
                </p>
              </div>

              {ready ? (
                <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-forest">
                  <Check className="size-3.5" aria-hidden />
                  Installed
                </span>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="shrink-0 gap-1.5 rounded-lg"
                  disabled={downloading}
                  onClick={() => {
                    setBusy((was) => ({ ...was, [language.code]: true }));
                    setErrors((was) => ({ ...was, [language.code]: "" }));
                    void voiceDownload(language.code).catch(() => {});
                  }}
                >
                  {downloading ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Download className="size-3.5" aria-hidden />
                  )}
                  {downloading ? "Downloading" : "Download voice"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </motion.section>
  );
}
