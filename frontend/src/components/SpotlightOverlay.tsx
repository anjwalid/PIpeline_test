import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Check, X } from 'lucide-react';

export interface SpotlightStep {
  target: string;
  title: string;
  description: string;
}

interface SpotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SpotlightOverlayProps {
  steps: SpotlightStep[];
  currentIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onDismiss: () => void;
}

const PAD = 10;
const TOOLTIP_W = 320;
const TOOLTIP_H = 200;

export function SpotlightOverlay({
  steps,
  currentIndex,
  onPrev,
  onNext,
  onDismiss,
}: Readonly<SpotlightOverlayProps>) {
  const [spot, setSpot] = useState<SpotRect | null>(null);
  const step = steps[currentIndex];
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === steps.length - 1;
  const total = steps.length;

  useEffect(() => {
    if (!step) return;
    setSpot(null);

    let t1: ReturnType<typeof setTimeout>;
    let t2: ReturnType<typeof setTimeout>;

    const measure = (): boolean => {
      const el = document.querySelector(`[data-guide-target="${step.target}"]`);
      if (!el) return false;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => {
        const r = el.getBoundingClientRect();
        setSpot({ x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 });
      }, 400);
      return true;
    };

    if (!measure()) {
      t1 = setTimeout(() => {
        if (!measure()) {
          t2 = setTimeout(measure, 350);
        }
      }, 150);
    }

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [step?.target]);

  if (!spot || !step) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const spaceBelow = vh - (spot.y + spot.h);
  const showBelow = spaceBelow >= TOOLTIP_H + 16;
  const tooltipTop = showBelow ? spot.y + spot.h + 14 : spot.y - TOOLTIP_H - 14;
  const tooltipLeft = Math.max(12, Math.min(spot.x, vw - TOOLTIP_W - 12));
  const arrowLeft = Math.max(16, Math.min(spot.x + spot.w / 2 - tooltipLeft - 7, TOOLTIP_W - 24));

  return (
    <div
      className="fixed inset-0 z-[200]"
      onClick={onDismiss}
      role="dialog"
      aria-modal="true"
      aria-label="Guide interactif"
    >
      <svg
        className="pointer-events-none absolute inset-0"
        style={{ display: 'block' }}
        width="100%"
        height="100%"
      >
        <defs>
          <mask id="spot-mask">
            <rect width="100%" height="100%" fill="white" />
            <rect x={spot.x} y={spot.y} width={spot.w} height={spot.h} rx="12" fill="black" />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.72)" mask="url(#spot-mask)" />
        <rect
          x={spot.x - 6}
          y={spot.y - 6}
          width={spot.w + 12}
          height={spot.h + 12}
          rx="18"
          fill="none"
          stroke="rgba(255,255,255,0.55)"
          strokeWidth="2"
        />
        <rect
          className="spotlight-ring"
          x={spot.x - 4}
          y={spot.y - 4}
          width={spot.w + 8}
          height={spot.h + 8}
          rx="16"
          fill="none"
          stroke="rgba(245,158,11,1)"
          strokeWidth="3.5"
        />
      </svg>

      <div
        className="absolute w-[320px] rounded-2xl border border-orange-200 bg-white p-4 shadow-[0_20px_60px_rgba(0,0,0,0.30)]"
        style={{ top: tooltipTop, left: tooltipLeft }}
        onClick={(e) => e.stopPropagation()}
      >
        {showBelow ? (
          <div
            className="absolute -top-[7px] h-3.5 w-3.5 rotate-45 border-l border-t border-orange-200 bg-white"
            style={{ left: arrowLeft }}
          />
        ) : (
          <div
            className="absolute -bottom-[7px] h-3.5 w-3.5 rotate-45 border-b border-r border-orange-200 bg-white"
            style={{ left: arrowLeft }}
          />
        )}

        <div className="mb-1.5 flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            {total > 1 && (
              <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-bold text-orange-600">
                {currentIndex + 1} / {total}
              </span>
            )}
            <p className="font-bold text-slate-900">{step.title}</p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Fermer le guide"
            className="shrink-0 rounded-full p-0.5 text-slate-400 transition hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-sm leading-relaxed text-slate-500">{step.description}</p>

        {total > 1 && (
          <div className="mt-3 flex gap-1">
            {steps.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${
                  i <= currentIndex ? 'bg-accent-primary' : 'bg-slate-200'
                }`}
              />
            ))}
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
          {!isFirst && (
            <button
              type="button"
              onClick={onPrev}
              className="flex items-center gap-1 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Précédent
            </button>
          )}
          <button
            type="button"
            onClick={isLast ? onDismiss : onNext}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-bold text-white transition hover:opacity-90 ${
              isLast
                ? 'bg-emerald-500'
                : 'bg-gradient-to-r from-accent-primary to-orange-500'
            }`}
          >
            {isLast ? (
              <>
                <Check className="h-4 w-4" />
                Terminer
              </>
            ) : (
              <>
                Suivant
                <ChevronRight className="h-3.5 w-3.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
