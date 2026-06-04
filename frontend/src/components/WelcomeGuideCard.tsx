import { useEffect, useState } from 'react';
import { ChevronRight, History, LayoutDashboard, Layers3, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Logoproj from '../../assets/LOGO_OF.png';

const STORAGE_KEY = 'astoria_onboarded_v1_';

function isOnboarded(username: string): boolean {
  return localStorage.getItem(STORAGE_KEY + username) === 'true';
}

function markOnboarded(username: string): void {
  localStorage.setItem(STORAGE_KEY + username, 'true');
}

const TOUR_OPTIONS: { id: string; icon: LucideIcon; label: string }[] = [
  { id: 'TOUR_ANALYSE',   icon: Layers3,         label: 'Faire une nouvelle analyse' },
  { id: 'TOUR_HISTORY',   icon: History,          label: "Consulter l'historique"     },
  { id: 'TOUR_DASHBOARD', icon: LayoutDashboard,  label: 'Comprendre le Dashboard'    },
];

interface WelcomeGuideCardProps {
  currentUserName: string;
  onStartTour: (tourId: string) => void;
}

export function WelcomeGuideCard({
  currentUserName,
  onStartTour,
}: Readonly<WelcomeGuideCardProps>) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isOnboarded(currentUserName)) return;
    const t = setTimeout(() => setVisible(true), 1500);
    return () => clearTimeout(t);
  }, [currentUserName]);

  const handleSkip = () => {
    markOnboarded(currentUserName);
    setVisible(false);
  };

  const handleStartTour = (tourId: string) => {
    markOnboarded(currentUserName);
    setVisible(false);
    onStartTour(tourId);
  };

  if (!visible) return null;

  return (
    <div className="fixed bottom-6 left-1/2 z-[150] w-[min(92vw,480px)] -translate-x-1/2">
      <div className="animate-slideUp overflow-hidden rounded-3xl border border-orange-200 bg-white shadow-[0_30px_90px_rgba(0,0,0,0.20)]">
        <div className="h-1.5 bg-gradient-to-r from-accent-primary via-orange-400 to-amber-300" />

        <div className="p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <img src={Logoproj} alt="Astoria" className="h-12 w-12 shrink-0 object-contain" />
              <div>
                <p className="font-extrabold text-slate-900">
                  Bienvenue, {currentUserName.split(' ')[0]} !
                </p>
                <p className="mt-0.5 text-sm text-slate-500">
                  Première visite ? Laissez-nous vous guider.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={handleSkip}
              aria-label="Ignorer"
              className="shrink-0 rounded-full p-1 text-slate-400 transition hover:text-slate-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <p className="mb-4 text-sm leading-relaxed text-slate-500">
            Choisissez un guide pour apprendre à utiliser l'application pas à pas.
          </p>

          <div className="mb-4 space-y-2">
            {TOUR_OPTIONS.map((tour) => {
              const Icon = tour.icon;
              return (
                <button
                  key={tour.id}
                  type="button"
                  onClick={() => handleStartTour(tour.id)}
                  className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-left text-sm font-semibold text-slate-700 transition-all hover:border-accent-primary hover:bg-orange-50 hover:text-accent-primary"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-orange-100">
                    <Icon className="h-4 w-4 text-accent-primary" />
                  </div>
                  {tour.label}
                  <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={handleSkip}
            className="w-full py-1 text-center text-sm text-slate-400 transition hover:text-slate-600"
          >
            Je connais déjà, merci
          </button>
        </div>
      </div>
    </div>
  );
}
