import { useEffect, useState } from 'react';
import {
  Bell,
  Menu,
  X,
  LogOut,
  ChevronRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import logoAttijari from '../../assets/logoAttijari.png';
import logoProj from "../../assets/LOGO_OF.png";

export interface NavItem<TSection extends string = string> {
  key: TSection;
  label: string;
  icon: LucideIcon;
}

export interface NavbarNotificationItem {
  id: string;
  title: string;
  description: string;
}

export interface NavbarNotificationCenter {
  title: string;
  unreadCount: number;
  items: NavbarNotificationItem[];
}

interface NavbarProps<TSection extends string = string> {
  isApiConnected: boolean;
  isDemoMode: boolean;
  activeSection: TSection;
  currentUserName: string;
  onNavigate: (section: TSection) => void;
  onLogout: () => void;
  navItems: NavItem<TSection>[];
  notificationCenter?: NavbarNotificationCenter | null;
}

export function Navbar<TSection extends string = string>({
  activeSection,
  currentUserName,
  onNavigate,
  onLogout,
  navItems,
  notificationCenter,
}: Readonly<NavbarProps<TSection>>) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isNotificationOpen, setIsNotificationOpen] = useState(false);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
        setIsNotificationOpen(false);
      }
    };

    globalThis.addEventListener('keydown', handleEscape);
    return () => globalThis.removeEventListener('keydown', handleEscape);
  }, []);

  const navigate = (section: TSection) => {
    onNavigate(section);
    setIsMenuOpen(false);
    setIsNotificationOpen(false);
  };

  const handleLogout = () => {
    setIsMenuOpen(false);
    setIsNotificationOpen(false);
    onLogout();
  };

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-50">
        <div className="mx-3 mt-3 md:mx-6">
          <div className="relative flex min-h-[74px] items-center justify-between rounded-2xl border border-white/60 bg-white/90 px-4 py-3 md:px-6 backdrop-blur-xl shadow-[0_10px_35px_rgba(15,23,42,0.08)]">
            <div className="flex min-w-0 items-center gap-3 md:gap-4">
              <button
                type="button"
                onClick={() => setIsMenuOpen((prev) => !prev)}
                className="group flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 transition-all duration-200 hover:border-slate-300 hover:bg-slate-50 hover:shadow-sm active:scale-[0.98]"
                aria-label="Ouvrir le menu"
                aria-expanded={isMenuOpen}
              >
                {isMenuOpen ? (
                  <X className="h-5 w-5 transition-transform duration-200 group-hover:rotate-90" />
                ) : (
                  <Menu className="h-5 w-5" />
                )}
              </button>

              <div className="flex min-w-0 items-center gap-3 md:gap-4">
                <img
                  src={logoAttijari}
                  alt="Attijari logo"
                  className="h-8 w-auto shrink-0 object-contain md:h-9"
                />

                <div className="hidden h-8 w-px shrink-0 bg-slate-200 md:block md:h-10" />

                <img
                  src={logoProj}
                  alt="Application logo"
                  className="h-14 w-auto shrink-0 object-contain md:h-16 xl:h-20"
                />

                <div className="hidden xl:block">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Plateforme interne
                  </p>
                  <p className="text-sm font-semibold text-slate-800">
                    Espace de pilotage
                  </p>
                </div>
              </div>
            </div>



            <div className="flex shrink-0 items-center gap-3">
              {notificationCenter && (
                <div className="relative hidden md:block">
                  <button
                    type="button"
                    onClick={() => setIsNotificationOpen((previous) => !previous)}
                    className="relative flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-slate-50"
                    aria-label="Ouvrir les notifications"
                    aria-expanded={isNotificationOpen}
                  >
                    <Bell className="h-5 w-5" />
                    {notificationCenter.unreadCount > 0 && (
                      <span className="absolute -right-1 -top-1 flex min-h-5 min-w-5 items-center justify-center rounded-full bg-orange-500 px-1.5 text-[10px] font-bold text-white">
                        {notificationCenter.unreadCount > 9 ? '9+' : notificationCenter.unreadCount}
                      </span>
                    )}
                  </button>

                  {isNotificationOpen && (
                    <div className="absolute right-0 top-14 z-50 w-[360px] overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_24px_70px_rgba(15,23,42,0.18)]">
                      <div className="border-b border-slate-100 px-5 py-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-bold text-slate-900">
                              {notificationCenter.title}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              Suivi des nouveautés sur les menaces du catalogue.
                            </p>
                          </div>
                          <span className="rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-700">
                            {notificationCenter.unreadCount} nouvelle{notificationCenter.unreadCount > 1 ? 's' : ''}
                          </span>
                        </div>
                      </div>

                      <div className="max-h-[360px] overflow-y-auto p-3">
                        {notificationCenter.items.length > 0 ? (
                          <div className="space-y-2">
                            {notificationCenter.items.map((item) => (
                              <div
                                key={item.id}
                                className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                              >
                                <p className="text-sm font-semibold text-slate-900">
                                  {item.title}
                                </p>
                                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                                  {item.description}
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">
                            Aucune nouveauté sur les menaces pour le moment.
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="hidden md:flex items-center gap-3 rounded-full border border-slate-200 bg-white px-2 py-2 shadow-sm">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-slate-900 to-slate-700 text-sm font-semibold text-white">
                  {currentUserName?.charAt(0)?.toUpperCase() || 'U'}
                </div>
                <div className="pr-2">
                  <p className="text-xs text-slate-400 leading-none">Connecté en tant que</p>
                  <p className="mt-1 text-sm font-semibold text-slate-800 leading-none">
                    {currentUserName}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </nav>

      {isMenuOpen && (
        <>
          <button
            type="button"
            onClick={() => setIsMenuOpen(false)}
            className="fixed inset-0 z-40 bg-slate-950/30 backdrop-blur-[3px]"
            aria-label="Fermer le menu"
          />

          <aside className="fixed left-3 top-[118px] z-50 max-h-[calc(100vh-136px)] w-[min(92vw,380px)] overflow-y-auto rounded-3xl border border-white/70 bg-white/95 shadow-[0_24px_70px_rgba(15,23,42,0.18)] backdrop-blur-2xl md:left-6 md:top-[126px] md:max-h-[calc(100vh-148px)]">
            <div className="h-1 w-full bg-gradient-to-r from-red-600 via-orange-500 to-amber-400" />

            <div className="border-b border-slate-100 px-6 py-5">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
                Navigation
              </p>
              <h2 className="mt-1 text-lg font-semibold text-slate-900">
                Menu principal
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Accédez rapidement aux sections principales.
              </p>
            </div>

            <div className="p-4 pb-5">
              <div className="space-y-2">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeSection === item.key;

                  return (
                    <button
                      key={item.key}
                      onClick={() => navigate(item.key)}
                      className={`group w-full rounded-2xl border px-4 py-3.5 text-left transition-all duration-200 ${
                        isActive
                          ? 'border-slate-900 bg-slate-900 text-white shadow-lg shadow-slate-900/10'
                          : 'border-transparent bg-slate-50/80 text-slate-700 hover:border-slate-200 hover:bg-white hover:shadow-sm'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div
                            className={`flex h-10 w-10 items-center justify-center rounded-xl ${
                              isActive
                                ? 'bg-white/12 text-white'
                                : 'bg-white text-slate-700 border border-slate-200'
                            }`}
                          >
                            <Icon className="h-4.5 w-4.5" />
                          </div>

                          <div>
                            <p
                              className={`text-sm font-semibold ${
                                isActive ? 'text-white' : 'text-slate-800'
                              }`}
                            >
                              {item.label}
                            </p>
                            <p
                              className={`text-xs ${
                                isActive ? 'text-slate-300' : 'text-slate-400'
                              }`}
                            >
                              Ouvrir la section
                            </p>
                          </div>
                        </div>

                        <ChevronRight
                          className={`h-4 w-4 transition-transform duration-200 ${
                            isActive
                              ? 'text-slate-300'
                              : 'text-slate-400 group-hover:translate-x-1'
                          }`}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="my-4 border-t border-slate-100" />

              <button
                onClick={handleLogout}
                className="group flex w-full items-center justify-between rounded-2xl border border-red-100 bg-red-50 px-4 py-3.5 text-left transition-all duration-200 hover:bg-red-100"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white border border-red-100 text-red-600">
                    <LogOut className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-red-700">Déconnexion</p>
                    <p className="text-xs text-red-400">Quitter la session en cours</p>
                  </div>
                </div>

                <ChevronRight className="h-4 w-4 text-red-400 transition-transform duration-200 group-hover:translate-x-1" />
              </button>
            </div>
          </aside>
        </>
      )}
    </>
  );
}
