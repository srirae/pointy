import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The shared step layout from the reference flow: one question per screen, centred,
 * with the heading and supporting line above a single card.
 */
export function Screen({
  title,
  lede,
  onBack,
  children,
  footnote,
}: {
  title: string;
  lede?: ReactNode;
  onBack?: () => void;
  children: ReactNode;
  footnote?: ReactNode;
}) {
  return (
    <div className="relative flex h-full flex-col items-center overflow-y-auto px-8 py-10">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="absolute top-10 left-10 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back
        </button>
      )}

      <div className="m-auto flex w-full max-w-2xl flex-col items-center">
        <h1 className="text-center font-serif text-[2.75rem] leading-[1.05] tracking-tight text-foreground">{title}</h1>
        {lede && (
          <p className="mt-4 max-w-lg text-center text-sm leading-relaxed text-muted-foreground">
            {lede}
          </p>
        )}

        <div className="mt-8 w-full">{children}</div>

        {footnote && (
          <p className="mt-5 max-w-md text-center text-xs leading-relaxed text-muted-foreground/80">
            {footnote}
          </p>
        )}
      </div>
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/70 bg-card p-7",
        "shadow-[0_1px_2px_rgba(46,58,71,0.04),0_18px_40px_-24px_rgba(46,58,71,0.22)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardQuestion({ children }: { children: ReactNode }) {
  return <p className="font-serif text-[1.375rem] font-medium tracking-tight text-foreground/90">{children}</p>;
}

/** Inset panel the reference uses to hold the thing being demonstrated. */
export function Stage({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "relative mt-5 flex items-center justify-center rounded-lg bg-secondary/60 px-6 py-8",
        className,
      )}
    >
      {children}
    </div>
  );
}
