import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import { PointyMark } from "@/components/pointy-mark";
import { GlassPreview } from "@/components/onboarding/glass-preview";
import { Button } from "@/components/ui/button";

const SLIDES = [
  {
    headline: "The AI that shows you where to click",
    lede: "Ask out loud when you get stuck. Pointy reads the screen, answers you, and points at the exact thing.",
  },
  {
    headline: "Hold a hotkey. A glass panel wakes up.",
    lede: "Speak your question or type it — Pointy sits on your screen in frosted glass, not a full-screen chat.",
  },
  {
    headline: "Answers that point, not paragraphs",
    lede: "Pointy reads what’s on screen, replies in the panel, and shows you exactly where to click.",
  },
] as const;

/**
 * Cinematic first beat — brand, value slides, and a live product demo.
 * Get Started appears after a short beat so the demo can land first (Wispr-style).
 */
export function Welcome({ onNext }: { onNext: () => void }) {
  const [slide, setSlide] = useState(0);
  const [ctaReady, setCtaReady] = useState(false);

  useEffect(() => {
    const show = window.setTimeout(() => setCtaReady(true), 900);
    return () => window.clearTimeout(show);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSlide((i) => (i + 1) % SLIDES.length);
    }, 5200);
    return () => window.clearInterval(timer);
  }, []);

  const current = SLIDES[slide];

  return (
    <div className="relative grid h-full grid-cols-1 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
      <div className="relative z-10 flex flex-col justify-center px-12 py-14 lg:px-16 xl:px-20">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 360, damping: 28 }}
          className="flex items-center gap-2.5"
        >
          <PointyMark className="size-7" />
          <span className="text-[0.8125rem] font-semibold tracking-[0.22em] uppercase">
            Pointy
          </span>
        </motion.div>

        <div className="relative mt-12 min-h-[9.5rem]">
          <AnimatePresence mode="wait">
            <motion.div
              key={slide}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
            >
              <h1 className="max-w-[18ch] font-serif text-[2.75rem] leading-[1.06] tracking-tight text-foreground lg:text-[3rem]">
                {current.headline}
              </h1>
              <p className="mt-5 max-w-[38ch] text-[0.975rem] leading-relaxed text-muted-foreground">
                {current.lede}
              </p>
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="mt-6 flex items-center gap-2" aria-hidden>
          {SLIDES.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setSlide(i)}
              className="group py-2"
              aria-label={`Slide ${i + 1}`}
            >
              <span
                className={
                  i === slide
                    ? "block h-1 w-7 rounded-full bg-forest transition-all"
                    : "block h-1 w-3 rounded-full bg-foreground/15 transition-all group-hover:bg-foreground/30"
                }
              />
            </button>
          ))}
        </div>

        <motion.div
          initial={false}
          animate={{ opacity: ctaReady ? 1 : 0, y: ctaReady ? 0 : 8 }}
          transition={{ type: "spring", stiffness: 380, damping: 28 }}
          className="mt-10 flex flex-col items-start gap-3"
        >
          <Button
            size="lg"
            onClick={onNext}
            disabled={!ctaReady}
            className="h-12 rounded-xl px-8 text-[0.9375rem] shadow-[0_12px_28px_-16px_rgba(13,74,71,0.65)]"
          >
            Get started
          </Button>
          <p className="text-xs text-muted-foreground/85">
            No account. About a minute — see the glass panel, pick your hotkey, say hello.
          </p>
        </motion.div>
      </div>

      <div className="relative hidden items-center justify-center overflow-hidden px-10 py-12 lg:flex">
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 18 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ delay: 0.15, type: "spring", stiffness: 280, damping: 26 }}
          className="relative w-full max-w-[26rem]"
        >
          <div className="absolute -inset-8 rounded-[2rem] bg-gradient-to-br from-forest/10 via-ochre/10 to-signal/15 blur-2xl" />
          <GlassPreview className="relative" />
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.8 }}
            className="mt-5 text-center text-[0.8125rem] leading-relaxed text-muted-foreground"
          >
            Voice wake + text — a glass panel on your screen, not a chat wall.
          </motion.p>
        </motion.div>
      </div>
    </div>
  );
}
