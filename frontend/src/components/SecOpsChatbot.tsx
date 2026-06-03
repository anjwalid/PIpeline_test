import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  ChevronRight,
  Expand,
  MessageCircleMore,
  Minimize2,
  Send,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import Logoproj from "../../assets/LOGO_OF.png";
import { SecOpsChatGuardrailError, SecOpsChatPopupError, sendSecOpsChatMessage } from '../api/secopsChat';
import type {
  SecOpsChatActionGroup,
  SecOpsChatActionOption,
  SecOpsChatDraftContext,
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
    content:
      'Bonjour, choisissez une aide questionnaire, rapport ou rubrique.',
  },
];

interface SecOpsChatbotProps {
  reportId?: string | null;
  draftContext?: SecOpsChatDraftContext | null;
}

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

export function SecOpsChatbot({
  reportId,
  draftContext,
}: Readonly<SecOpsChatbotProps>) {
  const [chatMode, setChatMode] = useState<'guided' | 'normal'>('guided');
  const [isOpen, setIsOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>(DEFAULT_MESSAGES);
  const [isSending, setIsSending] = useState(false);
  const [optionGroups, setOptionGroups] = useState<SecOpsChatActionGroup[]>([]);
  const [optionSearch, setOptionSearch] = useState('');
  const [position, setPosition] = useState<FloatingPosition>(() => getViewportPosition(CLOSED_DIMENSIONS));
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

  const filteredOptionGroups = useMemo(() => {
    const normalizedSearch = optionSearch.trim().toLowerCase();
    if (!normalizedSearch) {
      return optionGroups;
    }

    return optionGroups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) => option.label.toLowerCase().includes(normalizedSearch)),
      }))
      .filter((group) => group.options.length > 0);
  }, [optionGroups, optionSearch]);

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
      const height = isOpen ? Math.min(OPEN_DIMENSIONS.height, window.innerHeight - FLOATING_MARGIN * 2) : CLOSED_DIMENSIONS.height;
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

      setPosition({
        x: nextX,
        y: nextY,
      });
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
      const height = isOpen ? Math.min(OPEN_DIMENSIONS.height, window.innerHeight - FLOATING_MARGIN * 2) : CLOSED_DIMENSIONS.height;
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
      setOptionGroups(response.option_groups || []);
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
    if (!isOpen) return;
    if (chatMode === 'normal') {
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
      .replace(/```/g, '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  const handleSend = async () => {
    const trimmed = draft.trim();
    if (!trimmed || isSending) return;
    setDraft('');
    await requestChat({ message: trimmed }, { userMessage: trimmed });
  };

  const handleOptionClick = async (option: SecOpsChatActionOption) => {
    await requestChat(
      {
        action_id: option.action_id,
        action_payload: option.payload,
      },
      { userMessage: option.label }
    );
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
    setOptionSearch('');
    setMessages(DEFAULT_MESSAGES);
    setOptionGroups([]);
  };

  const shellClasses = isFullscreen
    ? 'h-[92vh] w-[min(1180px,96vw)] rounded-[34px] shadow-[0_40px_120px_rgba(15,23,42,0.28)]'
    : 'max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[430px] rounded-[30px] shadow-[0_30px_80px_rgba(15,23,42,0.22)]';
  const floatingStyle = !isOpen || !isFullscreen
    ? {
        left: `${position.x}px`,
        top: `${position.y}px`,
      }
    : undefined;

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
            className={`relative overflow-hidden bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.18),transparent_30%),linear-gradient(135deg,#a9362c_0%,#f25041_48%,#ffaf45_100%)] px-5 pb-5 pt-4 text-white ${
              isFullscreen ? '' : 'cursor-grab active:cursor-grabbing'
            } ${isDragging ? 'select-none' : ''}`}
          >
                <div className="relative flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <img src={Logoproj} alt="Application logo" className="h-12 w-12 shrink-0 object-contain" />
                <div className="min-w-0">
                  <p className="truncate text-lg font-extrabold tracking-tight">Guide interactif</p>
                  <p className="line-clamp-2 text-xs text-white/80">{headerSubtitle}</p>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const nextMode = chatMode === 'guided' ? 'normal' : 'guided';
                    setChatMode(nextMode);
                    setHasStarted(true);
                    setDraft('');
                    setOptionSearch('');
                    setOptionGroups([]);
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
                  className={`rounded-full px-3 py-2 text-xs font-semibold transition ${
                    chatMode === 'normal'
                      ? 'bg-white text-slate-900'
                      : 'bg-white/16 text-white hover:bg-white/24'
                  }`}
                >
                  {chatMode === 'normal' ? 'Chat normal' : 'Mode guide'}
                </button>
                <button
                  type="button"
                  onClick={() => setIsFullscreen((current) => !current)}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-white/16 text-white transition hover:bg-white/24"
                >
                  <Expand className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-white/16 text-white transition hover:bg-white/24"
                >
                  <Minimize2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={closeChat}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-700 transition hover:scale-105"
                >
                  <X className="h-4.5 w-4.5" />
                </button>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 bg-[linear-gradient(180deg,#fffdfb_0%,#ffffff_100%)] px-5 pb-5 pt-4">
            {!hasStarted ? (
              <div className="animate-fadeIn">
                <div className="mx-auto mb-4 flex justify-center">
                  <img src={Logoproj} alt="Application logo" className="h-16 w-16 object-contain" />
                </div>
                <div className="text-center">
                  <h3 className="text-[1.65rem] font-extrabold tracking-tight text-slate-900">Guide interactif</h3>
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
                  <div className="mb-4 flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50/90 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4.5 w-4.5 text-accent-primary" />
                      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Aide contextuelle</span>
                    </div>
                    <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                      {isSending ? 'Chargement...' : 'Disponible'}
                    </span>
                  </div>

                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[26px] border border-slate-200 bg-white/90">
                    <div className="flex-1 overflow-y-auto px-4 py-4 pr-3">
                      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end space-y-4">
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
                      <>
                    <div className="mb-5">
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                        Recherche
                      </p>
                      <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-3">
                        <input
                          type="text"
                          value={optionSearch}
                          onChange={(event) => setOptionSearch(event.target.value)}
                          placeholder="Filtrer rapports et options..."
                          className="h-11 w-full border-none bg-transparent text-sm text-slate-700 outline-none placeholder:text-slate-400"
                        />
                      </div>
                    </div>

                    {filteredOptionGroups.map((group) => (
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
                              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-medium text-slate-700 transition hover:border-accent-primary hover:text-accent-primary disabled:opacity-50"
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}

                    {filteredOptionGroups.length === 0 && (
                      <div className="rounded-2xl border border-dashed border-slate-200 bg-white/80 px-4 py-4 text-sm text-slate-500">
                        Aucun resultat pour cette recherche.
                      </div>
                    )}
                      </>
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
