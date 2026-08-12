import { PointyMark } from "@/components/pointy-mark";
import { Button } from "@/components/ui/button";

/**
 * Split welcome: product on the left, the photograph carrying the trust line on the
 * right. No account step — Pointy has no accounts, so setup starts here.
 */
export function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="grid h-full grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col justify-center px-12 py-16 lg:px-20">
        <div className="flex items-center gap-2.5">
          <PointyMark className="size-6" />
          <span className="text-[0.8125rem] font-semibold tracking-[0.22em] uppercase">
            Pointy
          </span>
        </div>

        <h1 className="mt-14 max-w-[22ch] text-[2.625rem] leading-[1.08] font-semibold">
          The AI that shows you where to click
        </h1>

        <p className="mt-5 max-w-[42ch] text-[0.9375rem] leading-relaxed text-muted-foreground">
          Ask out loud when you get stuck. Pointy reads the screen at that moment, answers you,
          and points at the exact thing to click.
        </p>

        <Button
          size="lg"
          onClick={onNext}
          className="mt-10 h-12 w-fit rounded-lg px-7 text-[0.9375rem]"
        >
          Get started
        </Button>

        <p className="mt-4 text-xs text-muted-foreground/80">
          No account, no sign-up. Setup takes about a minute.
        </p>
      </div>

      <div className="relative hidden overflow-hidden lg:block">
        <img
          src="/side.jpg"
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[#2E3A47]/78 via-[#2E3A47]/22 to-[#2E3A47]/55" />
        <p className="absolute inset-x-12 top-14 text-[1.3125rem] leading-[1.45] font-medium text-white/95">
          Your screen doesn’t need to leave your machine to help you — and when it does, for a
          moment, you’ll know exactly why.
        </p>
      </div>
    </div>
  );
}
