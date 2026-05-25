import { LogIn } from 'lucide-react';
import logoAttijari from '../../assets/logoAttijari.png';
import { AuthScene } from './AuthScene';

interface AuthViewProps {
  onLogin: () => void;
}

export function AuthView({ onLogin }: AuthViewProps) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[linear-gradient(180deg,#fffaf6_0%,#fff5ee_42%,#fffdfb_100%)]">
      <style>{`
        @keyframes authFloat {
          0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
          50% { transform: translate3d(0, -18px, 0) scale(1.04); }
        }
        @keyframes authDrift {
          0%, 100% { transform: translate3d(0, 0, 0); }
          50% { transform: translate3d(18px, 10px, 0); }
        }
        @keyframes authGlow {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.75; }
        }
      `}</style>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_16%,rgba(249,115,22,0.14),transparent_20%),radial-gradient(circle_at_78%_68%,rgba(251,146,60,0.12),transparent_22%),linear-gradient(135deg,rgba(255,255,255,0.65)_0%,rgba(255,247,240,0.82)_100%)]" />
      <div
        className="pointer-events-none absolute left-[8%] top-[14%] h-44 w-44 rounded-full bg-[radial-gradient(circle,rgba(251,146,60,0.22),rgba(251,146,60,0.02)_70%)] blur-2xl"
        style={{ animation: 'authFloat 14s ease-in-out infinite' }}
      />
      <div
        className="pointer-events-none absolute right-[10%] top-[22%] h-52 w-52 rounded-full bg-[radial-gradient(circle,rgba(249,115,22,0.18),rgba(249,115,22,0.01)_72%)] blur-3xl"
        style={{ animation: 'authDrift 18s ease-in-out infinite' }}
      />
      <div
        className="pointer-events-none absolute bottom-[10%] left-[18%] h-40 w-40 rounded-full bg-[radial-gradient(circle,rgba(253,186,116,0.18),rgba(253,186,116,0.01)_72%)] blur-3xl"
        style={{ animation: 'authFloat 16s ease-in-out infinite reverse' }}
      />
      <AuthScene />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-[#f97316] via-[#fb923c] to-[#fdba74]" />

      <div className="relative flex min-h-screen items-center justify-center px-4 py-8 sm:px-8">
        <div className="w-full max-w-[620px]">
          <div className="overflow-hidden rounded-[2.2rem] border border-white/80 bg-white/82 shadow-[0_32px_90px_rgba(249,115,22,0.14)] backdrop-blur-xl">
            <div className="h-1.5 bg-gradient-to-r from-[#f97316] via-[#fb923c] to-[#fdba74]" />

            <div className="px-8 pb-8 pt-10 sm:px-12">
              <div className="flex items-center justify-center">
                <img
                  src={logoAttijari}
                  alt="Attijari logo"
                  className="h-12 w-auto object-contain opacity-95 drop-shadow-[0_10px_18px_rgba(249,115,22,0.12)]"
                />
              </div>

              <div className="mt-10 text-center">
                <p className="text-[11px] font-semibold uppercase tracking-[0.38em] text-slate-500">
                  Plateforme interne
                </p>
                <h1 className="mt-5 font-serif text-[2.85rem] font-semibold tracking-[-0.03em] text-[#ea580c]">
                  Accès sécurisé
                </h1>
                <p className="mx-auto mt-4 max-w-xl text-[1.03rem] font-medium leading-8 text-slate-600">
                  Connectez-vous pour accéder à l’espace d’analyse et de pilotage sécurité.
                </p>
              </div>

              <div className="mt-10 space-y-5">
                <div className="rounded-[1.4rem] border border-orange-100/80 bg-[linear-gradient(180deg,rgba(255,247,237,0.9)_0%,rgba(255,255,255,0.92)_100%)] px-5 py-4 text-sm leading-7 text-slate-600">
                  Connexion sécurisée à votre espace.
                </div>

                <button
                  type="button"
                  onClick={onLogin}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-[1.2rem] border border-orange-200/60 bg-[linear-gradient(135deg,#ff8a1f_0%,#f97316_38%,#fb923c_100%)] py-4 font-sans text-[1rem] font-semibold text-white shadow-[0_18px_44px_rgba(249,115,22,0.22)] transition-all hover:-translate-y-0.5 hover:brightness-[1.03] hover:shadow-[0_24px_54px_rgba(249,115,22,0.28)]"
                  style={{ animation: 'authGlow 5s ease-in-out infinite' }}
                >
                  <LogIn className="h-5 w-5" />
                  Se connecter
                </button>

                <p className="text-center text-xs font-medium leading-6 text-slate-400">
                  Redirection vers le portail d’authentification sécurisé.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
