import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  AlertTriangle,
  AlignJustify,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Compass,
  Expand,
  FileText,
  HelpCircle,
  History,
  LayoutDashboard,
  Layers3,
  MessageCircleMore,
  Minimize2,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Logoproj from '../../assets/LOGO_OF.png';
import {
  SecOpsChatGuardrailError,
  SecOpsChatPopupError,
  sendSecOpsChatMessage,
} from '../api/secopsChat';
import type {
  SecOpsChatActionGroup,
  SecOpsChatActionOption,
  SecOpsChatDraftContext,
  SecOpsChatStepContext,
} from '../types';

type ChatMessage = {
  id: string;
  sender: 'bot' | 'user';
  content: string;
};

type FloatingPosition = {
  x: number;
  y: number;
};

type DragState = {
  pointerId: number;
  offsetX: number;
  offsetY: number;
};

const DEFAULT_MESSAGES: ChatMessage[] = [
  {
    id: 'welcome-bot',
    sender: 'bot',
    content: 'Bonjour, choisissez une aide questionnaire, rapport ou rubrique.',
  },
];

const CHIP_ICON_MAP: Record<string, LucideIcon> = {
  TOUR_ANALYSE: Layers3,
  TOUR_HISTORY: History,
  TOUR_DASHBOARD: LayoutDashboard,
  GUIDE_HIGHLIGHT_NAV_MENU: AlignJustify,
  GUIDE_HIGHLIGHT_ANALYSIS: Layers3,
  GUIDE_HIGHLIGHT_HISTORY: History,
  GUIDE_HIGHLIGHT_DASHBOARD: LayoutDashboard,
  GENERAL_THREAT_ENTRY: AlertTriangle,
  GENERAL_REPORTS_MENU: FileText,
  GENERAL_QUESTIONNAIRE_MENU: ClipboardList,
  SHOW_TOURS: Compass,
  REGULATORY_MENU: BookOpen,
};

const WELCOME_SHORTCUTS: { id: string; label: string; icon: LucideIcon; half: boolean }[] = [
  { id: 'NAV_ANALYSE', label: 'Faire une nouvelle analyse', icon: Layers3, half: false },
  { id: 'NAV_HISTORY', label: 'Consulter mes rapports', icon: History, half: false },
  { id: 'NAV_DASHBOARD', label: 'Voir le Dashboard', icon: LayoutDashboard, half: false },
  { id: 'REGULATORY_MENU', label: 'Explorer les normes & conformites', icon: BookOpen, half: false },
  { id: 'QUESTIONNAIRE_STEPS_MENU', label: 'Questionnaire', icon: ClipboardList, half: false },
  { id: 'SHOW_TOURS', label: 'Guide complet', icon: Compass, half: true },
  { id: 'SHOW_MAIN_MENU', label: 'Autres options', icon: HelpCircle, half: true },
];

const GUIDE_SECTION_MAP: Record<string, string> = {
  GUIDE_HIGHLIGHT_ANALYSIS: 'analysis',
  GUIDE_HIGHLIGHT_HISTORY: 'history',
  GUIDE_HIGHLIGHT_DASHBOARD: 'dashboard',
  GUIDE_HIGHLIGHT_NAV_MENU: 'nav-menu',
};

const FLOATING_MARGIN = 16;
const CLOSED_DIMENSIONS = { width: 260, height: 72 };
const OPEN_DIMENSIONS = { width: 430, height: 760 };
const DRAG_THRESHOLD = 6;

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function getViewportPosition(size: { width: number; height: number }): FloatingPosition {
  if (typeof window === 'undefined') {
    return { x: FLOATING_MARGIN, y: FLOATING_MARGIN };
  }

  return {
    x: Math.max(window.innerWidth - size.width - FLOATING_MARGIN, FLOATING_MARGIN),
    y: Math.max(window.innerHeight - size.height - FLOATING_MARGIN, FLOATING_MARGIN),
  };
}

interface SecOpsChatbotProps {
  reportId?: string | null;
  draftContext?: SecOpsChatDraftContext | null;
  currentSection?: string | null;
  viewState?: string | null;
  onGuideNavigate?: (section: string) => void;
  onStartTour?: (tourId: string) => void;
}

export function SecOpsChatbot({
  reportId,
  draftContext,
  currentSection,
  viewState,
  onGuideNavigate,
  onStartTour,
}: Readonly<SecOpsChatbotProps>) {
  const [chatMode, setChatMode] = useState<'guided' | 'normal'>('guided');
  const [isOpen, setIsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(DEFAULT_MESSAGES);
  const [isSending, setIsSending] = useState(false);
  const [optionGroups, setOptionGroups] = useState<SecOpsChatActionGroup[]>([]);
  const [activeShortcut, setActiveShortcut] = useState<string | null>(null);
  const [activeRegDoc, setActiveRegDoc] = useState<string | null>(null);
  const [regulatoryMenuGroups, setRegulatoryMenuGroups] = useState<SecOpsChatActionGroup[]>([]);
  const [activeStep, setActiveStep] = useState<SecOpsChatStepContext | null>(null);
  const [position, setPosition] = useState<FloatingPosition>(() =>
    getViewportPosition(CLOSED_DIMENSIONS)
  );
  const [isDragging, setIsDragging] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const dragMovedRef = useRef(false);
  const positionRef = useRef(position);

  const headerSubtitle = useMemo(() => {
    if (chatMode === 'normal') {
      return 'Assistant conversationnel libre';
    }
    if (draftContext?.active_question) {
      return 'Aide au remplissage et a la consultation';
    }
    return 'Guide par actions metier';
  }, [chatMode, draftContext]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, isSending]);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || isFullscreen) {
        return;
      }

      const width = isOpen ? OPEN_DIMENSIONS.width : CLOSED_DIMENSIONS.width;
      const height = isOpen
        ? Math.min(OPEN_DIMENSIONS.height, window.innerHeight - FLOATING_MARGIN * 2)
        : CLOSED_DIMENSIONS.height;
      const maxX = window.innerWidth - width - FLOATING_MARGIN;
      const maxY = window.innerHeight - height - FLOATING_MARGIN;
      const nextX = clamp(event.clientX - dragState.offsetX, FLOATING_MARGIN, maxX);
      const nextY = clamp(event.clientY - dragState.offsetY, FLOATING_MARGIN, maxY);

      if (
        Math.abs(nextX - positionRef.current.x) > DRAG_THRESHOLD ||
        Math.abs(nextY - positionRef.current.y) > DRAG_THRESHOLD
      ) {
        dragMovedRef.current = true;
      }

      setPosition({ x: nextX, y: nextY });
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!dragStateRef.current || dragStateRef.current.pointerId !== event.pointerId) {
        return;
      }

      dragStateRef.current = null;
      setIsDragging(false);
      window.setTimeout(() => {
        dragMovedRef.current = false;
      }, 0);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [isFullscreen, isOpen]);

  useEffect(() => {
    const handleResize = () => {
      if (isFullscreen) {
        return;
      }

      const width = isOpen ? OPEN_DIMENSIONS.width : CLOSED_DIMENSIONS.width;
      const height = isOpen
        ? Math.min(OPEN_DIMENSIONS.height, window.innerHeight - FLOATING_MARGIN * 2)
        : CLOSED_DIMENSIONS.height;
      const maxX = window.innerWidth - width - FLOATING_MARGIN;
      const maxY = window.innerHeight - height - FLOATING_MARGIN;

      setPosition((current) => ({
        x: clamp(current.x, FLOATING_MARGIN, maxX),
        y: clamp(current.y, FLOATING_MARGIN, maxY),
      }));
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isFullscreen, isOpen]);

  useEffect(() => {
    if (isFullscreen || typeof window === 'undefined') {
      return;
    }

    if (isOpen) {
      const panelWidth = Math.min(OPEN_DIMENSIONS.width, window.innerWidth - FLOATING_MARGIN * 2);
      setPosition({
        x: Math.max(window.innerWidth - panelWidth - FLOATING_MARGIN, FLOATING_MARGIN),
        y: FLOATING_MARGIN,
      });
      return;
    }

    setPosition(getViewportPosition(CLOSED_DIMENSIONS));
  }, [isOpen, isFullscreen]);

  const requestChat = async (
    payload: {
      message?: string;
      action_id?: string;
      action_payload?: Record<string, unknown>;
    },
    options?: {
      userMessage?: string;
      appendBotMessage?: boolean;
    }
  ) => {
    const userMessage = options?.userMessage?.trim();
    const nextHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [
      ...messages
        .filter((message) => message.id !== 'welcome-bot')
        .slice(-6)
        .map((message) => ({
          role: (message.sender === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: message.content,
        })),
      ...(userMessage ? [{ role: 'user' as const, content: userMessage }] : []),
    ].slice(-7);

    if (userMessage) {
      setMessages((current) => [
        ...current,
        {
          id: `user-${current.length + 1}`,
          sender: 'user',
          content: userMessage,
        },
      ]);
    }

    setHasStarted(true);
    setIsSending(true);

    try {
      const response = await sendSecOpsChatMessage({
        message: payload.message ?? '',
        report_id: reportId || undefined,
        draft_context: draftContext || undefined,
        chat_mode: chatMode,
        action_id: payload.action_id,
        action_payload: payload.action_payload,
        history: nextHistory,
        current_section: currentSection || undefined,
        view_state: viewState || undefined,
        regulatory_doc_context: activeRegDoc || undefined,
      });

      if (options?.appendBotMessage !== false) {
        setMessages((current) => [
          ...current,
          {
            id: `bot-${current.length + 1}`,
            sender: 'bot',
            content: response.reply,
          },
        ]);
      }

      const nextGroups = response.option_groups || [];
      setOptionGroups(nextGroups);

      if (activeShortcut === 'REGULATORY_MENU' && nextGroups.length > 0 && !activeRegDoc) {
        setRegulatoryMenuGroups(nextGroups);
      }
    } catch (error) {
      if (error instanceof SecOpsChatGuardrailError || error instanceof SecOpsChatPopupError) {
        return;
      }

      setMessages((current) => [
        ...current,
        {
          id: `bot-${current.length + 1}`,
          sender: 'bot',
          content:
            error instanceof Error
              ? error.message
              : "Le chatbot SecOps n'est pas disponible pour le moment.",
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (chatMode === 'normal') {
      setActiveShortcut(null);
      setActiveStep(null);
      setOptionGroups([]);
      setMessages([
        {
          id: 'welcome-general-bot',
          sender: 'bot',
          content: 'Mode chat normal active. Posez votre question librement.',
        },
      ]);
      return;
    }

    void requestChat({ action_id: 'SHOW_MAIN_MENU' }, { appendBotMessage: false });
  }, [chatMode, isOpen, reportId, draftContext?.active_question?.code]);

  const formatMessage = (content: string) =>
    content
      .replace(/\r\n/g, '\n')
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/```/g, '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  const handleSend = async () => {
    const trimmed = draft.trim();
    if (!trimmed || isSending) {
      return;
    }

    setDraft('');
    await requestChat({ message: trimmed }, { userMessage: trimmed });
  };

  const handleOptionClick = async (option: SecOpsChatActionOption) => {
    const guideSection = GUIDE_SECTION_MAP[option.action_id];
    if (guideSection) {
      setOptionGroups([]);
      setIsOpen(false);
      onGuideNavigate?.(guideSection);
      return;
    }

    if (option.action_id.startsWith('TOUR_')) {
      setOptionGroups([]);
      setIsOpen(false);
      onStartTour?.(option.action_id);
      return;
    }

    if (option.action_id.startsWith('REGULATORY_DOC')) {
      setActiveRegDoc(option.label);
    }

    await requestChat(
      {
        action_id: option.action_id,
        action_payload: option.payload,
      },
      { userMessage: option.label }
    );
  };

  const handleBack = () => {
    setActiveShortcut(null);
    setActiveRegDoc(null);
    setActiveStep(null);
    setMessages(DEFAULT_MESSAGES);
    setOptionGroups([]);
    setRegulatoryMenuGroups([]);
  };

  const handleShortcutClick = (shortcutId: string) => {
    if (shortcutId === 'NAV_ANALYSE') {
      setIsOpen(false);
      onGuideNavigate?.('analysis');
      return;
    }
    if (shortcutId === 'NAV_HISTORY') {
      setIsOpen(false);
      onGuideNavigate?.('history');
      return;
    }
    if (shortcutId === 'NAV_DASHBOARD') {
      setIsOpen(false);
      onGuideNavigate?.('dashboard');
      return;
    }
    if (shortcutId.startsWith('TOUR_')) {
      onStartTour?.(shortcutId);
      return;
    }
    if (shortcutId === 'QUESTIONNAIRE_STEPS_MENU') {
      setActiveShortcut('QUESTIONNAIRE_STEPS_MENU');
      return;
    }

    setActiveShortcut(shortcutId);
    void requestChat({ action_id: shortcutId });
  };

  const handleStart = () => {
    setIsOpen(true);
    setHasStarted(true);
    setMessages(DEFAULT_MESSAGES);
  };

  const handleDragStart = (
    event: ReactPointerEvent<HTMLElement>,
    options?: { allowInteractiveTarget?: boolean }
  ) => {
    if (isFullscreen) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (!options?.allowInteractiveTarget && target?.closest('button, input, textarea')) {
      return;
    }

    dragMovedRef.current = false;
    dragStateRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - position.x,
      offsetY: event.clientY - position.y,
    };
    setIsDragging(true);
  };

  const closeChat = () => {
    setIsOpen(false);
    setIsFullscreen(false);
    setHasStarted(false);
    setChatMode('guided');
    setDraft('');
    setMessages(DEFAULT_MESSAGES);
    setOptionGroups([]);
    setActiveShortcut(null);
    setActiveRegDoc(null);
    setActiveStep(null);
    setRegulatoryMenuGroups([]);
  };

  const shellClasses = isFullscreen
    ? 'h-[92vh] w-[min(1180px,96vw)] rounded-[34px] shadow-[0_40px_120px_rgba(15,23,42,0.28)]'
    : 'max-h-[calc(100vh-1rem)] w-[calc(100vw-1rem)] max-w-[430px] rounded-[30px] shadow-[0_30px_80px_rgba(15,23,42,0.22)] sm:max-h-[calc(100vh-2rem)] sm:w-[calc(100vw-2rem)]';
  const floatingStyle =
    !isOpen || !isFullscreen
      ? {
          left: `${position.x}px`,
          top: `${position.y}px`,
        }
      : undefined;
  const hasUserMessages = messages.some((message) => message.sender === 'user');
  const sideGroups = regulatoryMenuGroups.length > 0 ? regulatoryMenuGroups : optionGroups;

  return (
    <div
      className={`fixed flex ${
        isOpen
          ? isFullscreen
            ? 'inset-0 z-[90] items-center justify-center p-4 sm:p-6'
            : 'z-[70] items-start'
          : 'z-40 items-end'
      }`}
      style={floatingStyle}
    >
      {isOpen && isFullscreen && (
        <button
          type="button"
          aria-label="Fermer le mode plein ecran"
          onClick={() => setIsFullscreen(false)}
          className="absolute inset-0 bg-slate-950/35 backdrop-blur-[2px]"
        />
      )}

      {isOpen ? (
        <div
          className={`relative flex min-h-0 flex-col overflow-hidden border border-white/70 bg-white/95 backdrop-blur-2xl ${shellClasses}`}
        >
          <div className="h-1.5 bg-gradient-to-r from-accent-primary via-orange-400 to-amber-300" />
          <div
            onPointerDown={handleDragStart}
            className={`relative overflow-hidden bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.18),transparent_30%),linear-gradient(135deg,#a9362c_0%,#f25041_48%,#ffaf45_100%)] px-4 pb-4 pt-4 text-white sm:px-5 sm:pb-5 ${
              isFullscreen ? '' : 'cursor-grab active:cursor-grabbing'
            } ${isDragging ? 'select-none' : ''}`}
          >
            <div className="relative flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-start gap-3 pr-2">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/14 ring-1 ring-white/20 backdrop-blur-sm sm:h-12 sm:w-12">
                  <img src={Logoproj} alt="Application logo" className="h-9 w-9 object-contain sm:h-10 sm:w-10" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <p className="truncate text-base font-extrabold tracking-tight text-white sm:text-lg">
                      Guide interactif
                    </p>
                    <Sparkles className="h-4 w-4 shrink-0 text-amber-200" />
                  </div>
                  <p className="mt-1 line-clamp-2 max-w-[170px] text-[11px] leading-4 text-white/80 sm:max-w-none sm:text-xs">
                    {headerSubtitle}
                  </p>
                </div>
              </div>

              <div className="flex shrink-0 items-start gap-1.5 sm:gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const nextMode = chatMode === 'guided' ? 'normal' : 'guided';
                    setChatMode(nextMode);
                    setHasStarted(true);
                    setDraft('');
                    setOptionGroups([]);
                    setActiveRegDoc(null);
                    setRegulatoryMenuGroups([]);
                    setActiveShortcut(null);
                    setActiveStep(null);
                    setMessages(
                      nextMode === 'normal'
                        ? [
                            {
                              id: 'welcome-general-bot',
                              sender: 'bot',
                              content: 'Mode chat normal active. Posez votre question librement.',
                            },
                          ]
                        : DEFAULT_MESSAGES
                    );
                  }}
                  className={`rounded-full px-2.5 py-2 text-[11px] font-semibold transition sm:px-3 sm:text-xs ${
                    chatMode === 'normal'
                      ? 'bg-white text-slate-900'
                      : 'bg-white/16 text-white hover:bg-white/24'
                  }`}
                >
                  <span className="hidden sm:inline">
                    {chatMode === 'normal' ? 'Chat normal' : 'Mode guide'}
                  </span>
                  <span className="sm:hidden">{chatMode === 'normal' ? 'Normal' : 'Guide'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsFullscreen((current) => !current)}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white/16 text-white transition hover:bg-white/24 sm:h-10 sm:w-10"
                  aria-label={isFullscreen ? 'Quitter le plein ecran' : 'Passer en plein ecran'}
                >
                  <Expand className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white/16 text-white transition hover:bg-white/24 sm:h-10 sm:w-10"
                  aria-label="Reduire le chatbot"
                >
                  <Minimize2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={closeChat}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-slate-700 shadow-sm transition hover:scale-105 sm:h-10 sm:w-10"
                  aria-label="Fermer le chatbot"
                >
                  <X className="h-4.5 w-4.5" />
                </button>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 bg-[linear-gradient(180deg,#fffdfb_0%,#ffffff_100%)] px-4 pb-4 pt-3 sm:px-5 sm:pb-5 sm:pt-4">
            {!hasStarted ? (
              <div className="animate-fadeIn">
                <div className="mx-auto mb-4 flex justify-center">
                  <img src={Logoproj} alt="Application logo" className="h-16 w-16 object-contain" />
                </div>
                <div className="text-center">
                  <h3 className="text-[1.65rem] font-extrabold tracking-tight text-slate-900">
                    Guide interactif
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-500">
                    Aide guidee pour le formulaire, les rapports et la navigation.
                  </p>
                </div>
                <div className="mt-5 rounded-2xl border border-orange-100 bg-[linear-gradient(135deg,rgba(255,247,237,0.95),rgba(255,255,255,0.92))] p-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-accent-primary shadow-sm">
                      <Sparkles className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-semibold text-slate-800">Pret pour une aide guidee.</p>
                      <p className="mt-1 text-sm leading-relaxed text-slate-500">
                        Ouvrez le panneau puis cliquez sur les options proposees.
                      </p>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleStart}
                  className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-accent-primary via-accent-secondary to-orange-500 px-5 py-3.5 text-sm font-bold text-white"
                >
                  Demarrer
                  <ChevronRight className="h-4.5 w-4.5" />
                </button>
              </div>
            ) : (
              <div className={`h-full min-h-0 animate-fadeIn ${isFullscreen ? 'grid grid-cols-[minmax(0,1fr)_340px] gap-5' : 'flex flex-col'}`}>
                <div className="flex min-h-0 min-w-0 flex-col">
                  <div className="mb-4 flex items-center justify-between rounded-2xl border border-slate-200/90 bg-slate-50/90 px-3.5 py-3 sm:px-4">
                    <div className="flex min-w-0 items-center gap-2">
                      <ShieldCheck className="h-4.5 w-4.5 text-accent-primary" />
                      <span className="truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 sm:text-xs">
                        Aide contextuelle
                      </span>
                    </div>
                    <span className="ml-3 shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                      {isSending ? 'Chargement...' : 'Disponible'}
                    </span>
                  </div>

                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[26px] border border-slate-200 bg-white/90">
                    <div className="flex-1 overflow-y-auto px-4 py-4 pr-3">
                      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end space-y-4">
                        {hasUserMessages && chatMode === 'guided' && (
                          <button
                            type="button"
                            onClick={handleBack}
                            className="flex items-center gap-1.5 self-start rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-500 shadow-sm transition hover:border-accent-primary hover:text-accent-primary"
                          >
                            <ChevronLeft className="h-3 w-3 shrink-0" />
                            Retour au menu
                          </button>
                        )}

                        {draftContext?.active_question && (
                          <div className="rounded-2xl border border-orange-100 bg-[linear-gradient(135deg,#fff8f1,#fff3ea)] px-4 py-3 text-sm text-slate-700">
                            <p className="font-semibold text-slate-900">
                              Question active : {draftContext.active_question.number || draftContext.active_question.code}
                            </p>
                            <p className="mt-1">{draftContext.active_question.label}</p>
                          </div>
                        )}

                        {messages.map((message) => (
                          <div
                            key={message.id}
                            className={`flex items-start gap-3 ${message.sender === 'user' ? 'justify-end' : 'justify-start'}`}
                          >
                            {message.sender === 'bot' && (
                              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#fff7ed,#ffe7dc)] ring-1 ring-orange-100">
                                <img src={Logoproj} alt="Application logo" className="h-5 w-5 object-contain" />
                              </div>
                            )}
                            <div
                              className={`max-w-[88%] rounded-[22px] px-4 py-3 text-sm leading-7 shadow-sm ${
                                message.sender === 'user'
                                  ? 'bg-slate-900 text-white'
                                  : 'border border-orange-100 bg-[linear-gradient(135deg,#fff8f1,#fff3ea)] text-slate-700'
                              }`}
                            >
                              <div className="space-y-2">
                                {formatMessage(message.content).map((line, index) => (
                                  <p key={`${message.id}-${index}`} className="break-words">
                                    {line}
                                  </p>
                                ))}
                              </div>
                            </div>
                          </div>
                        ))}

                        {chatMode === 'guided' && !activeShortcut && !activeStep && !hasUserMessages && !isSending && (
                          <div className="space-y-2 pt-2">
                            {WELCOME_SHORTCUTS.filter(
                              (shortcut) =>
                                !shortcut.half &&
                                (shortcut.id !== 'QUESTIONNAIRE_STEPS_MENU' ||
                                  (draftContext?.questionnaire_steps &&
                                    draftContext.questionnaire_steps.length > 0))
                            ).map((shortcut) => {
                              const Icon = shortcut.icon;
                              return (
                                <button
                                  key={shortcut.id}
                                  type="button"
                                  onClick={() => handleShortcutClick(shortcut.id)}
                                  className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3.5 text-left text-sm font-semibold text-slate-700 shadow-sm transition hover:border-accent-primary hover:bg-orange-50 hover:text-accent-primary"
                                >
                                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-100">
                                    <Icon className="h-4 w-4 text-accent-primary" />
                                  </div>
                                  {shortcut.label}
                                  <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                                </button>
                              );
                            })}
                            <div className="grid grid-cols-2 gap-2">
                              {WELCOME_SHORTCUTS.filter((shortcut) => shortcut.half).map((shortcut) => {
                                const Icon = shortcut.icon;
                                return (
                                  <button
                                    key={shortcut.id}
                                    type="button"
                                    onClick={() => handleShortcutClick(shortcut.id)}
                                    className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-accent-primary hover:bg-orange-50 hover:text-accent-primary"
                                  >
                                    <Icon className="h-4 w-4 shrink-0 text-accent-primary" />
                                    <span className="truncate">{shortcut.label}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {chatMode === 'guided' &&
                          activeShortcut === 'QUESTIONNAIRE_STEPS_MENU' &&
                          !activeStep &&
                          !hasUserMessages &&
                          !isSending && (
                            <div className="space-y-2 pt-2">
                              <button
                                type="button"
                                onClick={handleBack}
                                className="mb-1 flex items-center gap-1.5 text-sm font-medium text-slate-400 transition hover:text-accent-primary"
                              >
                                <ChevronLeft className="h-4 w-4" />
                                Retour
                              </button>
                              <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                                Dans quelle page du questionnaire veux-tu de l'aide ?
                              </p>
                              <div className="space-y-1.5">
                                {draftContext?.questionnaire_steps?.map((step) => (
                                  <button
                                    key={step.title}
                                    type="button"
                                    onClick={() => setActiveStep(step)}
                                    className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-700 shadow-sm transition hover:border-accent-primary hover:bg-orange-50 hover:text-accent-primary"
                                  >
                                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-orange-50">
                                      <ClipboardList className="h-4 w-4 text-accent-primary" />
                                    </div>
                                    <span className="truncate">{step.title}</span>
                                    <span className="ml-auto shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-bold text-orange-700">
                                      {step.questions.length}
                                    </span>
                                    <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                        {chatMode === 'guided' && activeStep && !hasUserMessages && !isSending && (
                          <div className="space-y-2 pt-2">
                            <button
                              type="button"
                              onClick={() => setActiveStep(null)}
                              className="mb-1 flex items-center gap-1.5 text-sm font-medium text-slate-400 transition hover:text-accent-primary"
                            >
                              <ChevronLeft className="h-4 w-4" />
                              Retour aux etapes
                            </button>
                            <p className="px-1 text-xs font-semibold text-slate-500">{activeStep.title}</p>
                            {activeStep.questions.map((question) => (
                              <button
                                key={question.code}
                                type="button"
                                onClick={() => {
                                  void requestChat(
                                    {
                                      action_id: 'QUESTIONNAIRE_QUESTION_SELECT',
                                      action_payload: { question_code: question.code },
                                    },
                                    { userMessage: question.label }
                                  );
                                  setActiveStep(null);
                                  setActiveShortcut('QUESTIONNAIRE_QUESTION_SELECT');
                                }}
                                className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-semibold text-slate-700 shadow-sm transition hover:border-accent-primary hover:bg-orange-50 hover:text-accent-primary"
                              >
                                <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                                <span className="line-clamp-2">{question.label}</span>
                              </button>
                            ))}
                          </div>
                        )}

                        {chatMode === 'guided' &&
                          activeShortcut &&
                          activeShortcut !== 'QUESTIONNAIRE_STEPS_MENU' &&
                          !hasUserMessages && (
                            <div className="space-y-2 pt-2">
                              <button
                                type="button"
                                onClick={handleBack}
                                className="mb-1 flex items-center gap-1.5 text-sm font-medium text-slate-400 transition hover:text-accent-primary"
                              >
                                <ChevronLeft className="h-4 w-4" />
                                Retour aux raccourcis
                              </button>
                              {!isSending &&
                                optionGroups.flatMap((group) => group.options).map((option) => {
                                  const Icon = CHIP_ICON_MAP[option.action_id] ?? ChevronRight;
                                  return (
                                    <button
                                      key={option.label}
                                      type="button"
                                      onClick={() => void handleOptionClick(option)}
                                      disabled={isSending}
                                      className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3.5 text-left text-sm font-semibold text-slate-700 shadow-sm transition hover:border-accent-primary hover:bg-orange-50 hover:text-accent-primary disabled:opacity-50"
                                    >
                                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-100">
                                        <Icon className="h-4 w-4 text-accent-primary" />
                                      </div>
                                      {option.label}
                                      <ChevronRight className="ml-auto h-4 w-4 text-slate-400" />
                                    </button>
                                  );
                                })}
                            </div>
                          )}

                        {isSending && (
                          <div className="flex items-start gap-3">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#fff7ed,#ffe7dc)] ring-1 ring-orange-100">
                              <img src={Logoproj} alt="Application logo" className="h-5 w-5 object-contain" />
                            </div>
                            <div className="rounded-[22px] border border-orange-100 bg-[linear-gradient(135deg,#fff8f1,#fff3ea)] px-4 py-3 text-slate-500 shadow-sm">
                              <div className="flex items-center gap-1.5">
                                <span className="h-2 w-2 animate-pulse rounded-full bg-orange-300" />
                                <span className="h-2 w-2 animate-pulse rounded-full bg-orange-400 [animation-delay:120ms]" />
                                <span className="h-2 w-2 animate-pulse rounded-full bg-orange-500 [animation-delay:240ms]" />
                              </div>
                            </div>
                          </div>
                        )}
                        <div ref={messagesEndRef} />
                      </div>
                    </div>

                    {!isSending && hasUserMessages && chatMode === 'guided' && (
                      <div className="border-t border-orange-50 bg-orange-50/40 px-3 py-2">
                        <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-none">
                          <button
                            type="button"
                            onClick={handleBack}
                            className="shrink-0 flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-500 transition hover:border-accent-primary hover:text-accent-primary"
                          >
                            <ChevronLeft className="h-3 w-3 shrink-0" />
                            Menu
                          </button>
                          {sideGroups.flatMap((group) => group.options).map((option) => {
                            const Icon = CHIP_ICON_MAP[option.action_id] ?? ChevronRight;
                            const isActive = activeRegDoc === option.label;
                            return (
                              <button
                                key={option.label}
                                type="button"
                                onClick={() => void handleOptionClick(option)}
                                disabled={isSending}
                                className={`shrink-0 flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
                                  isActive
                                    ? 'border-accent-primary bg-orange-100 text-accent-primary'
                                    : 'border-orange-200 bg-white text-orange-700 hover:border-accent-primary hover:bg-orange-100'
                                }`}
                              >
                                <Icon className="h-3 w-3 shrink-0" />
                                {option.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="border-t border-slate-100 px-4 pb-4 pt-3">
                      <div className="rounded-[24px] border border-slate-200 bg-white px-3 py-2">
                        <div className="flex items-center gap-3">
                          <MessageCircleMore className="h-4.5 w-4.5 shrink-0 text-slate-400" />
                          <input
                            type="text"
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                void handleSend();
                              }
                            }}
                            placeholder={
                              chatMode === 'normal'
                                ? 'Posez votre question librement...'
                                : 'Question libre ou detail complementaire...'
                            }
                            className="h-11 min-w-0 flex-1 border-none bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
                          />
                          <button
                            type="button"
                            onClick={() => void handleSend()}
                            disabled={isSending || draft.trim().length === 0}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-accent-primary to-orange-500 text-white transition hover:scale-105 disabled:opacity-50"
                          >
                            <Send className="h-4.5 w-4.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <aside className={`${isFullscreen ? 'hidden xl:flex' : 'hidden sm:flex'} min-h-0 overflow-hidden rounded-[28px] border border-slate-200 bg-[linear-gradient(180deg,#fffaf6_0%,#ffffff_100%)] flex-col`}>
                  <div className="flex-1 overflow-y-auto p-4">
                    {chatMode === 'normal' ? (
                      <div className="rounded-2xl border border-dashed border-slate-200 bg-white/80 px-4 py-4 text-sm text-slate-500">
                        Le mode chat normal masque les options guidees pour laisser la place aux questions libres.
                      </div>
                    ) : (
                      sideGroups
                        .filter((group) => !group.title.toLowerCase().includes('questionnaire'))
                        .map((group) => (
                          <div key={group.title} className="mb-5">
                            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                              {group.title}
                            </p>
                            <div className="mt-3 space-y-2">
                              {group.options.map((option) => (
                                <button
                                  key={`${group.title}-${option.label}`}
                                  type="button"
                                  onClick={() => void handleOptionClick(option)}
                                  disabled={isSending}
                                  className={`w-full rounded-2xl border px-4 py-3 text-left text-sm font-medium transition disabled:opacity-50 ${
                                    activeRegDoc === option.label
                                      ? 'border-accent-primary bg-orange-50 text-accent-primary'
                                      : 'border-slate-200 bg-white text-slate-700 hover:border-accent-primary hover:text-accent-primary'
                                  }`}
                                >
                                  {option.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))
                    )}
                  </div>
                </aside>
              </div>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            if (dragMovedRef.current) {
              return;
            }
            setIsOpen(true);
          }}
          onPointerDown={(event) => handleDragStart(event, { allowInteractiveTarget: true })}
          className="group flex items-center gap-3 rounded-[28px] border border-white/80 bg-white/96 px-4 py-3 shadow-[0_18px_50px_rgba(15,23,42,0.16)] backdrop-blur-xl transition hover:-translate-y-0.5"
          aria-label="Ouvrir le chatbot AWB Guard"
        >
          <img src={Logoproj} alt="Astoria logo" className="h-12 w-12 shrink-0 object-contain" />
          <div className="hidden min-w-0 pr-1 text-left sm:block">
            <p className="truncate text-[1rem] font-extrabold tracking-tight text-slate-900">ASTORIA Guard</p>
            <p className="truncate text-sm font-medium text-slate-500">Assistant SecOps</p>
          </div>
        </button>
      )}
    </div>
  );
}
