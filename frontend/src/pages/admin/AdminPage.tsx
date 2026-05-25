import {
  BookOpen,
  ChevronDown,
  Database,
  Download,
  Edit3,
  History,
  LayoutDashboard,
  LibraryBig,
  Link2,
  Network,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { fetchAuditTrail } from '../../api/audit';
import { fetchCveGraphStats, searchCveGraph } from '../../api/cveGraph';
import {
  createCatalogReference,
  createInternalSecuritySolution,
  deleteCatalogReferenceRecord,
  deleteInternalSecuritySolution,
  exportCatalogThreatWorkbook,
  fetchCatalogReferenceGroups,
  fetchCatalogReferences,
  fetchCatalogThreat,
  fetchCatalogThreats,
  fetchInternalSecuritySolutions,
  updateInternalSecuritySolution,
  updateCatalogReferenceRecord,
} from '../../api/catalog';
import keycloak from '../../auth/keycloak';
import { CveGraphExplorer } from '../../components/CveGraphExplorer';
import { Navbar } from '../../components/Navbar';
import {
  showConfirmAlert,
  showErrorAlert,
  showInfoAlert,
  showSuccessAlert,
} from '../../utils/alerts';
import { API_BASE_URL } from '../../config';
import type {
  AuditTrailEntry,
  CatalogMitigation,
  CatalogReference,
  CatalogReferenceGroup,
  CatalogScenario,
  CatalogThreat,
  CatalogThreatListItem,
  CatalogThreatUpsertPayload,
  CveGraphSearchResponse,
  CveGraphStats,
  InternalSecuritySolution,
  QuestionAnswerContext,
  Question,
  QuestionnaireListItem,
  Questionnaire,
  QuestionnaireStep,
  QuestionnaireUpsertPayload,
} from '../../types';

type AdminSection = 'dashboard' | 'catalog' | 'questionnaire' | 'references' | 'internal_solutions' | 'cve_graph' | 'traceability';

interface AdminPageProps {
  currentUserName: string;
  onLogout: () => void;
}

type EditableStep = Omit<QuestionnaireStep, 'questions'> & {
  questions: Question[];
};

type EditableQuestionnaire = Omit<Questionnaire, 'steps' | 'questions'> & {
  steps: EditableStep[];
  questions: Question[];
};

type EditableCatalogThreat = CatalogThreat;

interface ReferenceInsight {
  id: number;
  code: string;
  label: string;
  lien?: string | null;
  threatCount: number;
}

interface EditableInternalSolutionForm {
  id_solution: number | null;
  nom_solution: string;
  type_solution: string;
  editeur_solution: string;
  usage_securite: string;
  description_solution: string;
  actif: boolean;
}

function buildAuthHeaders(contentType = false): HeadersInit {
  const headers: HeadersInit = {};

  if (contentType) {
    headers['Content-Type'] = 'application/json';
  }

  if (keycloak.authenticated && keycloak.token) {
    headers.Authorization = `Bearer ${keycloak.token}`;
  }

  return headers;
}

interface EditableReferenceForm {
  id_reference: number | null;
  reference_menace: string;
  nom_reference: string;
  lien: string;
}

let tempEntityId = -1;

function createTempId() {
  tempEntityId -= 1;
  return tempEntityId;
}

function createEmptyOption(displayOrder: number) {
  const label = `Option ${displayOrder}`;
  return {
    id: createTempId(),
    question_id: createTempId(),
    label,
    value: buildOptionValue(label),
    display_order: displayOrder,
    visibility_rules: [],
  };
}

function createEmptyOptionVisibilityRule(
  optionValue: string,
  dependsOnQuestionCode: string,
  expectedValue: string
) {
  return {
    id: createTempId(),
    question_option_id: createTempId(),
    depends_on_question_id: createTempId(),
    operator: 'equals' as const,
    expected_value: expectedValue,
    option_value: optionValue,
    depends_on_question_code: dependsOnQuestionCode,
  };
}

function buildOptionValue(label: string) {
  const normalized = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  return normalized || 'OPTION';
}

function createEmptyQuestion(stepId: number, displayOrder: number): Question {
  return {
    id: createTempId(),
    step_id: stepId,
    code: `question_${displayOrder}`,
    label: 'Nouvelle question',
    help_text: '',
    aide: '',
    question_type: 'boolean',
    is_required: false,
    display_order: displayOrder,
    default_value: '',
    is_active: true,
    backend_key: '',
    send_if_true_only: false,
    options: [],
    visibility_rules: [],
    answer_contexts: [],
  };
}

function createEmptyAnswerContext(question: Question): QuestionAnswerContext {
  const normalizedType = question.question_type;
  let optionValue = '';

  if (normalizedType === 'boolean') {
    optionValue = 'true';
  } else if ((question.options ?? []).length > 0) {
    optionValue = question.options?.[0]?.value ?? '';
  }

  return {
    id: createTempId(),
    questionnaire_code: '',
    question_code: question.code,
    option_value: optionValue,
    context_category: '',
    llm_sentence: '',
    diagram_hint: '',
  };
}

function createEmptyStep(stepOrder: number): EditableStep {
  return {
    id: createTempId(),
    questionnaire_id: undefined,
    code: `step_${stepOrder}`,
    title: `Étape ${stepOrder}`,
    step_order: stepOrder,
    questions: [],
  };
}

function createEmptyCatalogMitigation(threatId: number): CatalogMitigation {
  return {
    id_mitigation: createTempId(),
    id_menace: threatId,
    description_mitigation: 'Nouvelle mitigation',
  };
}

function createEmptyCatalogScenario(threatId: number): CatalogScenario {
  return {
    id_scenario: createTempId(),
    id_menace: threatId,
    description_scenario: 'Nouveau scenario',
  };
}

function createEmptyCatalogThreat(): EditableCatalogThreat {
  const threatId = createTempId();
  return {
    id_menace: threatId,
    nom_menace: 'Nouvelle menace',
    description: '',
    reference_menace: '',
    mitigations: [],
    scenarios: [],
    references: [],
  };
}

function decorateQuestionnaire(questionnaire: Questionnaire): EditableQuestionnaire {
  const questionsByStep = questionnaire.questions.reduce<Record<number, Question[]>>(
    (accumulator, question) => {
      if (!accumulator[question.step_id]) {
        accumulator[question.step_id] = [];
      }

      accumulator[question.step_id].push(question);
      return accumulator;
    },
    {}
  );

  return {
    ...questionnaire,
    steps: questionnaire.steps.map((step) => ({
      ...step,
      questions: [...(questionsByStep[step.id] ?? [])]
        .map((question) => ({
          ...question,
          options: (question.options ?? []).map((option) => ({
            ...option,
            visibility_rules: option.visibility_rules ?? [],
          })),
          answer_contexts: question.answer_contexts ?? [],
        }))
        .sort((left, right) => left.display_order - right.display_order),
    })),
    questions: questionnaire.questions.map((question) => ({
      ...question,
      options: (question.options ?? []).map((option) => ({
        ...option,
        visibility_rules: option.visibility_rules ?? [],
      })),
      answer_contexts: question.answer_contexts ?? [],
    })),
  };
}

function buildQuestionnairePayload(questionnaire: EditableQuestionnaire): QuestionnaireUpsertPayload {
  return {
    code: questionnaire.code,
    name: questionnaire.name,
    version: questionnaire.version,
    status: questionnaire.status,
    is_active: questionnaire.is_active,
    steps: questionnaire.steps
      .slice()
      .sort((left, right) => left.step_order - right.step_order)
      .map((step) => ({
        code: step.code,
        title: step.title,
        step_order: step.step_order,
        questions: (step.questions ?? [])
          .slice()
          .sort((left, right) => left.display_order - right.display_order)
          .map((question) => ({
            code: question.code,
            label: question.label,
            help_text: question.help_text ?? '',
            aide: question.aide ?? '',
            question_type: question.question_type,
            is_required: question.is_required,
            display_order: question.display_order,
            default_value: question.default_value ?? '',
            is_active: question.is_active,
            backend_key: question.backend_key ?? '',
            send_if_true_only: question.send_if_true_only,
            options: (question.options ?? [])
              .slice()
              .sort((left, right) => left.display_order - right.display_order)
              .map((option) => ({
                label: option.label,
                value: option.value,
                display_order: option.display_order,
                visibility_rules: (option.visibility_rules ?? []).map((rule) => ({
                  option_value: rule.option_value ?? option.value,
                  depends_on_question_code: rule.depends_on_question_code ?? '',
                  operator: rule.operator,
                  expected_value: rule.expected_value,
                })),
              })),
            visibility_rules: (question.visibility_rules ?? []).map((rule) => ({
              question_code: rule.question_code ?? question.code,
              depends_on_question_code: rule.depends_on_question_code ?? '',
              operator: rule.operator,
              expected_value: rule.expected_value,
            })),
            answer_contexts: (question.answer_contexts ?? [])
              .filter((context) => context.option_value.trim().length > 0)
              .map((context) => ({
                option_value: context.option_value,
                context_category: context.context_category ?? '',
                llm_sentence: context.llm_sentence ?? '',
                diagram_hint: context.diagram_hint ?? '',
              })),
          })),
      })),
  };
}

function buildCatalogThreatPayload(threat: EditableCatalogThreat): CatalogThreatUpsertPayload {
  return {
    nom_menace: threat.nom_menace,
    description: threat.description ?? '',
    reference_menace: threat.reference_menace ?? '',
    mitigations: threat.mitigations
      .filter((mitigation) => mitigation.description_mitigation.trim().length > 0)
      .map((mitigation) => ({
        description_mitigation: mitigation.description_mitigation,
      })),
    scenarios: threat.scenarios
      .filter((scenario) => scenario.description_scenario.trim().length > 0)
      .map((scenario) => ({
        description_scenario: scenario.description_scenario,
      })),
    references: threat.references
      .filter(
        (reference) =>
          reference.reference_menace.trim().length > 0 || reference.nom_reference.trim().length > 0
      )
      .map((reference) => ({
        id_reference: reference.id_reference,
        reference_menace: reference.reference_menace,
        nom_reference: reference.nom_reference,
        lien: reference.lien ?? '',
      })),
  };
}

function updateOptionInQuestion(question: Question, optionId: number, field: 'label' | 'value', value: string) {
  return {
    ...question,
    options: (question.options ?? []).map((option) => {
      if (option.id !== optionId) {
        return option;
      }

      if (field === 'label') {
        const nextOptionValue = buildOptionValue(value);
        return {
          ...option,
          label: value,
          value: nextOptionValue,
          visibility_rules: (option.visibility_rules ?? []).map((rule) => ({
            ...rule,
            option_value: nextOptionValue,
          })),
        };
      }

      return { ...option, [field]: value };
    }),
  };
}

function summarizeText(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  if (normalized.length <= 72) return normalized;
  return `${normalized.slice(0, 69)}...`;
}

function formatAuditActionLabel(actionType: string) {
  return actionType
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ');
}

function formatAuditDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function previewAuditPayload(value: Record<string, unknown> | null | undefined) {
  if (!value) return '';
  const serialized = JSON.stringify(value);
  if (serialized.length <= 180) return serialized;
  return `${serialized.slice(0, 177)}...`;
}

function clampOrder(value: number, max: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(1, value), Math.max(1, max));
}

function normalizeAdminText(value: string | null | undefined) {
  return (value ?? '').trim().toLocaleLowerCase('fr-FR');
}

function moveItemToRequestedOrder<T extends { id: number; display_order: number }>(
  items: T[],
  itemId: number,
  requestedOrder: number
) {
  const currentIndex = items.findIndex((item) => item.id === itemId);
  if (currentIndex === -1) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(currentIndex, 1);
  const targetIndex = clampOrder(requestedOrder, items.length) - 1;

  nextItems.splice(targetIndex, 0, movedItem);

  return nextItems.map((item, index) => ({
    ...item,
    display_order: index + 1,
  }));
}

function updateVisibilityRuleInQuestion(
  question: Question,
  ruleIndex: number,
  field: 'depends_on_question_code' | 'operator' | 'expected_value',
  value: string
) {
  return {
    ...question,
    visibility_rules: (question.visibility_rules ?? []).map((rule, index) =>
      index === ruleIndex ? { ...rule, [field]: value } : rule
    ),
  };
}

function updateOptionVisibilityRuleInQuestion(
  question: Question,
  optionId: number,
  ruleIndex: number,
  field: 'depends_on_question_code' | 'operator' | 'expected_value',
  value: string
) {
  return {
    ...question,
    options: (question.options ?? []).map((option) => {
      if (option.id !== optionId) {
        return option;
      }

      return {
        ...option,
        visibility_rules: (option.visibility_rules ?? []).map((rule, index) =>
          index === ruleIndex ? { ...rule, [field]: value } : rule
        ),
      };
    }),
  };
}

function updateAnswerContextInQuestion(
  question: Question,
  contextId: number,
  field: 'option_value' | 'context_category' | 'llm_sentence' | 'diagram_hint',
  value: string
) {
  return {
    ...question,
    answer_contexts: (question.answer_contexts ?? []).map((context) =>
      context.id === contextId ? { ...context, [field]: value } : context
    ),
  };
}

export function AdminPage({ currentUserName, onLogout }: Readonly<AdminPageProps>) {
  const [activeSection, setActiveSection] = useState<AdminSection>('dashboard');
  const [questionnaires, setQuestionnaires] = useState<QuestionnaireListItem[]>([]);
  const [catalogThreats, setCatalogThreats] = useState<CatalogThreatListItem[]>([]);
  const [newThreatNotifications, setNewThreatNotifications] = useState<CatalogThreatListItem[]>([]);
  const [catalogReferences, setCatalogReferences] = useState<CatalogReference[]>([]);
  const [catalogReferenceGroups, setCatalogReferenceGroups] = useState<CatalogReferenceGroup[]>([]);
  const [internalSecuritySolutions, setInternalSecuritySolutions] = useState<InternalSecuritySolution[]>([]);
  const [auditTrailEntries, setAuditTrailEntries] = useState<AuditTrailEntry[]>([]);
  const [cveGraphStats, setCveGraphStats] = useState<CveGraphStats | null>(null);
  const [cveGraphResult, setCveGraphResult] = useState<CveGraphSearchResponse | null>(null);
  const [cveGraphSearch, setCveGraphSearch] = useState('');
  const [referenceForm, setReferenceForm] = useState<EditableReferenceForm>({
    id_reference: null,
    reference_menace: '',
    nom_reference: '',
    lien: '',
  });
  const [internalSolutionForm, setInternalSolutionForm] = useState<EditableInternalSolutionForm>({
    id_solution: null,
    nom_solution: '',
    type_solution: '',
    editeur_solution: '',
    usage_securite: '',
    description_solution: '',
    actif: true,
  });
  const [selectedQuestionnaireId, setSelectedQuestionnaireId] = useState<number | null>(null);
  const [selectedQuestionnaire, setSelectedQuestionnaire] = useState<EditableQuestionnaire | null>(null);
  const [selectedCatalogThreatId, setSelectedCatalogThreatId] = useState<number | null>(null);
  const [selectedCatalogThreat, setSelectedCatalogThreat] = useState<EditableCatalogThreat | null>(null);
  const [catalogThreatSearch, setCatalogThreatSearch] = useState('');
  const [selectedStepId, setSelectedStepId] = useState<number | null>(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState<number | null>(null);
  const [isLoadingQuestionnaires, setIsLoadingQuestionnaires] = useState(false);
  const [isLoadingQuestionnaire, setIsLoadingQuestionnaire] = useState(false);
  const [isLoadingCatalogThreats, setIsLoadingCatalogThreats] = useState(false);
  const [isLoadingCatalogThreat, setIsLoadingCatalogThreat] = useState(false);
  const [isLoadingAuditTrail, setIsLoadingAuditTrail] = useState(false);
  const [isLoadingCveGraph, setIsLoadingCveGraph] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingCatalogThreat, setIsSavingCatalogThreat] = useState(false);
  const [isExportingCatalog, setIsExportingCatalog] = useState(false);
  const [catalogStatusMessage, setCatalogStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const refreshQuestionnaires = async (preferredQuestionnaireId?: number | null) => {
    try {
      setIsLoadingQuestionnaires(true);
      setErrorMessage('');

      const response = await fetch(`${API_BASE_URL}/admin/questionnaires`, {
        headers: buildAuthHeaders(),
      });
      if (!response.ok) {
        throw new Error('Impossible de charger les questionnaires.');
      }

      const data = (await response.json()) as QuestionnaireListItem[];
      setQuestionnaires(data);
      if (typeof preferredQuestionnaireId === 'number') {
        setSelectedQuestionnaireId(preferredQuestionnaireId);
      } else if (data.length > 0 && selectedQuestionnaireId === null) {
        setSelectedQuestionnaireId(data[0].id);
      }
      if (data.length === 0) {
        setSelectedQuestionnaireId(null);
        setSelectedQuestionnaire(null);
        setSelectedStepId(null);
        setSelectedQuestionId(null);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Erreur de chargement.');
    } finally {
      setIsLoadingQuestionnaires(false);
    }
  };

  const refreshCatalogThreats = async (preferredThreatId?: number | null) => {
    try {
      setIsLoadingCatalogThreats(true);
      setErrorMessage('');

      const data = await fetchCatalogThreats();
      setNewThreatNotifications((previous) => {
        if (catalogThreats.length === 0) {
          return previous;
        }

        const knownThreatIds = new Set(catalogThreats.map((threat) => threat.id_menace));
        const appendedThreats = data.filter((threat) => !knownThreatIds.has(threat.id_menace));

        if (appendedThreats.length === 0) {
          return previous;
        }

        const mergedThreats = [...appendedThreats, ...previous];
        const uniqueThreats = mergedThreats.filter(
          (threat, index, array) =>
            array.findIndex((candidate) => candidate.id_menace === threat.id_menace) === index
        );

        return uniqueThreats.slice(0, 6);
      });
      setCatalogThreats(data);
      if (typeof preferredThreatId === 'number') {
        setSelectedCatalogThreatId(preferredThreatId);
      } else if (data.length > 0 && selectedCatalogThreatId === null) {
        setSelectedCatalogThreatId(data[0].id_menace);
      }

      if (data.length === 0) {
        setSelectedCatalogThreatId(null);
        setSelectedCatalogThreat(null);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Erreur de chargement.');
    } finally {
      setIsLoadingCatalogThreats(false);
    }
  };

  const refreshCatalogReferences = async () => {
    try {
      setErrorMessage('');
      const [references, groups] = await Promise.all([
        fetchCatalogReferences(),
        fetchCatalogReferenceGroups(),
      ]);
      setCatalogReferences(references);
      setCatalogReferenceGroups(groups);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Erreur de chargement des references.');
    }
  };

  const refreshInternalSecuritySolutions = async () => {
    try {
      setErrorMessage('');
      const data = await fetchInternalSecuritySolutions();
      setInternalSecuritySolutions(data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Erreur de chargement des solutions internes.');
    }
  };

  const refreshAuditTrailEntries = async () => {
    try {
      setIsLoadingAuditTrail(true);
      setErrorMessage('');
      const data = await fetchAuditTrail(300);
      setAuditTrailEntries(data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Erreur de chargement de la tracabilite.');
    } finally {
      setIsLoadingAuditTrail(false);
    }
  };

  const refreshCveGraphStats = async () => {
    try {
      const data = await fetchCveGraphStats();
      setCveGraphStats(data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Erreur de chargement du graphe CVE.');
    }
  };

  const runCveGraphSearch = async (query = cveGraphSearch) => {
    try {
      setIsLoadingCveGraph(true);
      setErrorMessage('');
      const data = await searchCveGraph(query, 30);
      setCveGraphResult(data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Erreur de recherche dans le graphe CVE.');
    } finally {
      setIsLoadingCveGraph(false);
    }
  };

  useEffect(() => {
    void refreshQuestionnaires();
    void refreshCatalogThreats();
    void refreshCatalogReferences();
    void refreshInternalSecuritySolutions();
    void refreshAuditTrailEntries();
    void refreshCveGraphStats();
  }, []);

  useEffect(() => {
    if (activeSection === 'cve_graph' && cveGraphResult === null && !isLoadingCveGraph) {
      void runCveGraphSearch('');
    }
  }, [activeSection, cveGraphResult, isLoadingCveGraph]);

  useEffect(() => {
    const loadQuestionnaire = async () => {
      if (selectedQuestionnaireId === null) {
        setSelectedQuestionnaire(null);
        setSelectedStepId(null);
        setSelectedQuestionId(null);
        return;
      }

      try {
        setIsLoadingQuestionnaire(true);
        setErrorMessage('');

        const response = await fetch(`${API_BASE_URL}/admin/questionnaires/${selectedQuestionnaireId}`, {
          headers: buildAuthHeaders(),
        });
        if (!response.ok) {
          throw new Error('Impossible de charger le questionnaire sélectionné.');
        }

        const data = (await response.json()) as Questionnaire;
        const decorated = decorateQuestionnaire(data);
        setSelectedQuestionnaire(decorated);
        setSelectedStepId(decorated.steps[0]?.id ?? null);
        setSelectedQuestionId(decorated.steps[0]?.questions[0]?.id ?? null);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Erreur de chargement.');
      } finally {
        setIsLoadingQuestionnaire(false);
      }
    };

    void loadQuestionnaire();
  }, [selectedQuestionnaireId]);

  useEffect(() => {
    const loadCatalogThreat = async () => {
      if (selectedCatalogThreatId === null) {
        setSelectedCatalogThreat(null);
        return;
      }

      try {
        setIsLoadingCatalogThreat(true);
        setErrorMessage('');

        const data = await fetchCatalogThreat(selectedCatalogThreatId);
        setSelectedCatalogThreat(data);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Erreur de chargement.');
      } finally {
        setIsLoadingCatalogThreat(false);
      }
    };

    void loadCatalogThreat();
  }, [selectedCatalogThreatId]);

  const selectedStep = useMemo(() => {
    if (!selectedQuestionnaire || selectedStepId === null) return null;
    return selectedQuestionnaire.steps.find((step) => step.id === selectedStepId) ?? null;
  }, [selectedQuestionnaire, selectedStepId]);

  const selectedQuestion = useMemo(() => {
    if (!selectedStep || selectedQuestionId === null) return null;
    return selectedStep.questions.find((question) => question.id === selectedQuestionId) ?? null;
  }, [selectedStep, selectedQuestionId]);

  const selectedQuestionContextValues = useMemo(() => {
    if (!selectedQuestion) return [];

    if (selectedQuestion.question_type === 'boolean') {
      return ['true', 'false'];
    }

    return (selectedQuestion.options ?? [])
      .map((option) => option.value.trim())
      .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
  }, [selectedQuestion]);

  const availableVisibilityQuestions = useMemo(() => {
    if (!selectedQuestionnaire || !selectedQuestion) return [];

    return selectedQuestionnaire.steps
      .slice()
      .sort((left, right) => left.step_order - right.step_order)
      .flatMap((step) =>
        (step.questions ?? [])
          .slice()
          .sort((left, right) => left.display_order - right.display_order)
          .map((question) => ({
            ...question,
            step_order: step.step_order,
            step_title: step.title,
          }))
      )
      .filter((question) => question.id !== selectedQuestion.id)
      .filter((question) => {
        if (question.step_order < (selectedStep?.step_order ?? 0)) return true;
        if (question.step_order > (selectedStep?.step_order ?? 0)) return false;
        return question.display_order < selectedQuestion.display_order;
      });
  }, [selectedQuestionnaire, selectedQuestion, selectedStep]);

  const getRuleQuestionByCode = (questionCode: string) =>
    availableVisibilityQuestions.find((question) => question.code === questionCode) ?? null;

  const getExpectedValueOptions = (questionCode: string) => {
    const dependencyQuestion = getRuleQuestionByCode(questionCode);
    if (!dependencyQuestion) return [];

    if (dependencyQuestion.question_type === 'boolean') {
      return ['true', 'false'];
    }

    return (dependencyQuestion.options ?? [])
      .map((option) => option.value.trim())
      .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
  };

  const dashboardStats = useMemo(() => {
    const totalSteps = selectedQuestionnaire?.steps?.length ?? 0;
    const totalQuestions =
      selectedQuestionnaire?.questions?.filter((question) => question.is_active).length ?? 0;
    const activeQuestionnaires = questionnaires.filter((questionnaire) => questionnaire.is_active).length;

    return { totalSteps, totalQuestions, activeQuestionnaires };
  }, [questionnaires, selectedQuestionnaire]);

  const catalogDashboardStats = useMemo(() => {
    const totalThreats = catalogThreats.length;
    const totalScenarios = catalogThreats.reduce(
      (sum, threat) => sum + threat.scenario_count,
      0
    );
    const totalMitigations = catalogThreats.reduce(
      (sum, threat) => sum + threat.mitigation_count,
      0
    );
    const totalReferences = catalogThreats.reduce(
      (sum, threat) => sum + threat.reference_count,
      0
    );

    return { totalThreats, totalScenarios, totalMitigations, totalReferences };
  }, [catalogThreats]);

  const filteredCatalogThreats = useMemo(() => {
    const search = catalogThreatSearch.trim().toLowerCase();
    if (!search) {
      return catalogThreats;
    }

    return catalogThreats.filter((threat) => {
      const haystack = [
        threat.nom_menace,
        threat.reference_menace ?? '',
        threat.description ?? '',
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(search);
    });
  }, [catalogThreats, catalogThreatSearch]);

  const referenceInsights = useMemo<ReferenceInsight[]>(
    () =>
      catalogReferenceGroups.map((group, index) => ({
        id: index + 1,
        code: group.reference_codes.join(', '),
        label: group.display_name,
        lien: null,
        threatCount: group.code_count,
      })),
    [catalogReferenceGroups]
  );

  const referenceStats = useMemo(() => {
    const totalUniqueReferences = referenceInsights.length;
    const totalThreatLinks = referenceInsights.reduce((sum, item) => sum + item.threatCount, 0);
    const topReference = referenceInsights[0] ?? null;
    const averageThreatsPerReference =
      totalUniqueReferences > 0 ? Number((totalThreatLinks / totalUniqueReferences).toFixed(1)) : 0;

    return {
      totalUniqueReferences,
      totalThreatLinks,
      topReference,
      averageThreatsPerReference,
    };
  }, [referenceInsights]);

  const internalSolutionStats = useMemo(() => {
    const totalSolutions = internalSecuritySolutions.length;
    const activeSolutions = internalSecuritySolutions.filter((solution) => solution.actif).length;
    const uniqueCategories = new Set(
      internalSecuritySolutions
        .map((solution) => solution.type_solution.trim().toUpperCase())
        .filter(Boolean)
    ).size;

    return {
      totalSolutions,
      activeSolutions,
      uniqueCategories,
    };
  }, [internalSecuritySolutions]);

  const threatNotifications = useMemo(() => {
    const unreadCount = newThreatNotifications.length;
    const items =
      unreadCount > 0
        ? [
            {
              id: 'new-threats-summary',
              title: `${unreadCount} nouvelle${unreadCount > 1 ? 's' : ''} menace${unreadCount > 1 ? 's' : ''}`,
              description:
                unreadCount > 1
                  ? `Le catalogue contient ${unreadCount} nouvelles menaces à vérifier dans la section Catalogue.`
                  : 'Le catalogue contient 1 nouvelle menace à vérifier dans la section Catalogue.',
            },
          ]
        : [];

    return {
      title: 'Notifications sécurité',
      unreadCount,
      items,
    };
  }, [newThreatNotifications]);

  const updateQuestionnaireField = <K extends keyof EditableQuestionnaire>(
    field: K,
    value: EditableQuestionnaire[K]
  ) => {
    setSelectedQuestionnaire((previous) =>
      previous ? { ...previous, [field]: value } : previous
    );
  };

  const updateCatalogThreatField = <K extends keyof EditableCatalogThreat>(
    field: K,
    value: EditableCatalogThreat[K]
  ) => {
    setSelectedCatalogThreat((previous) =>
      previous ? { ...previous, [field]: value } : previous
    );
  };

  const updateStep = (
    stepId: number,
    updater: (step: EditableStep) => EditableStep
  ) => {
    setSelectedQuestionnaire((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        steps: previous.steps.map((step) => (step.id === stepId ? updater(step) : step)),
      };
    });
  };

  const updateQuestion = (
    stepId: number,
    questionId: number,
    updater: (question: Question) => Question
  ) => {
    updateStep(stepId, (step) => ({
      ...step,
      questions: step.questions.map((question) => (question.id === questionId ? updater(question) : question)),
    }));
  };

  const reorderQuestionDisplayOrder = (stepId: number, questionId: number, requestedOrder: number) => {
    updateStep(stepId, (step) => ({
      ...step,
      questions: moveItemToRequestedOrder(step.questions, questionId, requestedOrder),
    }));
  };

  const updateCatalogMitigation = (
    mitigationId: number,
    updater: (mitigation: CatalogMitigation) => CatalogMitigation
  ) => {
    setSelectedCatalogThreat((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        mitigations: previous.mitigations.map((mitigation) =>
          mitigation.id_mitigation === mitigationId ? updater(mitigation) : mitigation
        ),
      };
    });
  };

  const updateCatalogScenario = (
    scenarioId: number,
    updater: (scenario: CatalogScenario) => CatalogScenario
  ) => {
    setSelectedCatalogThreat((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        scenarios: previous.scenarios.map((scenario) =>
          scenario.id_scenario === scenarioId ? updater(scenario) : scenario
        ),
      };
    });
  };

  const updateCatalogReference = (
    referenceId: number,
    updater: (reference: CatalogReference) => CatalogReference
  ) => {
    setSelectedCatalogThreat((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        references: previous.references.map((reference) =>
          reference.id_reference === referenceId ? updater(reference) : reference
        ),
      };
    });
  };

  const handleCreateQuestionnaire = () => {
    const draft: EditableQuestionnaire = {
      id: createTempId(),
      code: 'nouveau-questionnaire',
      name: 'Nouveau questionnaire',
      version: 1,
      status: 'draft',
      is_active: false,
      steps: [],
      questions: [],
    };

    setSelectedQuestionnaire(draft);
    setSelectedQuestionnaireId(null);
    setSelectedStepId(null);
    setSelectedQuestionId(null);
    setActiveSection('questionnaire');
  };

  const handleCreateCatalogThreat = () => {
    setSelectedCatalogThreat(createEmptyCatalogThreat());
    setSelectedCatalogThreatId(null);
    setCatalogStatusMessage('');
    setActiveSection('catalog');
  };

  const handleSelectQuestionnaire = async (questionnaireId: number) => {
    setSelectedQuestionnaireId(questionnaireId);
    setActiveSection('questionnaire');
  };

  const handleSelectCatalogThreat = (threatId: number) => {
    setSelectedCatalogThreatId(threatId);
    setCatalogStatusMessage('');
    setActiveSection('catalog');
  };

  const handleAddStep = () => {
    if (!selectedQuestionnaire) return;

    const nextOrder = selectedQuestionnaire.steps.length + 1;
    const newStep = createEmptyStep(nextOrder);
    const newQuestion = createEmptyQuestion(newStep.id, 1);
    newStep.questions.push(newQuestion);

    setSelectedQuestionnaire((previous) =>
      previous
        ? {
            ...previous,
            steps: [...previous.steps, newStep],
          }
        : previous
    );
    setSelectedStepId(newStep.id);
    setSelectedQuestionId(newQuestion.id);
  };

  const handleDeleteStep = (stepId: number) => {
    if (!selectedQuestionnaire) return;

    const nextSteps = selectedQuestionnaire.steps.filter((step) => step.id !== stepId);
    setSelectedQuestionnaire({
      ...selectedQuestionnaire,
      steps: nextSteps.map((step, index) => ({
        ...step,
        step_order: index + 1,
      })),
    });

    if (selectedStepId === stepId) {
      setSelectedStepId(nextSteps[0]?.id ?? null);
      setSelectedQuestionId(nextSteps[0]?.questions?.[0]?.id ?? null);
    }
  };

  const handleAddQuestion = () => {
    if (!selectedStep) return;

    const newQuestion = createEmptyQuestion(selectedStep.id, selectedStep.questions.length + 1);
    updateStep(selectedStep.id, (step) => ({
      ...step,
      questions: [...step.questions, newQuestion],
    }));
    setSelectedQuestionId(newQuestion.id);
  };

  const handleDeleteQuestion = (questionId: number) => {
    if (!selectedStep) return;

    const remainingQuestions = selectedStep.questions.filter((question) => question.id !== questionId);
    updateStep(selectedStep.id, (step) => ({
      ...step,
      questions: remainingQuestions.map((question, index) => ({
        ...question,
        display_order: index + 1,
      })),
    }));

    if (selectedQuestionId === questionId) {
      setSelectedQuestionId(remainingQuestions[0]?.id ?? null);
    }
  };

  const handleAddOption = () => {
    if (!selectedStep || !selectedQuestion) return;

    const nextOrder = (selectedQuestion.options?.length ?? 0) + 1;
    updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
      ...question,
      options: [...(question.options ?? []), createEmptyOption(nextOrder)],
    }));
  };

  const handleDeleteOption = (optionId: number) => {
    if (!selectedStep || !selectedQuestion) return;

    updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
      ...question,
      options: (question.options ?? [])
        .filter((option) => option.id !== optionId)
        .map((option, index) => ({
          ...option,
          display_order: index + 1,
        })),
    }));
  };

  const handleAddOptionVisibilityRule = (optionId: number) => {
    if (!selectedStep || !selectedQuestion) return;

    const targetOption = (selectedQuestion.options ?? []).find((option) => option.id === optionId);
    if (!targetOption) return;

    const firstDependencyQuestion = availableVisibilityQuestions[0];
    const firstQuestionCode = firstDependencyQuestion?.code ?? '';
    const firstExpectedValue =
      firstDependencyQuestion?.question_type === 'boolean'
        ? 'true'
        : firstDependencyQuestion?.options?.[0]?.value ?? '';

    updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
      ...question,
      options: (question.options ?? []).map((option) =>
        option.id === optionId
          ? {
              ...option,
              visibility_rules: [
                ...(option.visibility_rules ?? []),
                createEmptyOptionVisibilityRule(
                  option.value,
                  firstQuestionCode,
                  firstExpectedValue
                ),
              ],
            }
          : option
      ),
    }));
  };

  const handleDeleteOptionVisibilityRule = (optionId: number, ruleId: number) => {
    if (!selectedStep || !selectedQuestion) return;

    updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
      ...question,
      options: (question.options ?? []).map((option) =>
        option.id === optionId
          ? {
              ...option,
              visibility_rules: (option.visibility_rules ?? []).filter((rule) => rule.id !== ruleId),
            }
          : option
      ),
    }));
  };

  const handleAddVisibilityRule = () => {
    if (!selectedStep || !selectedQuestion) return;

    const firstDependencyQuestion = availableVisibilityQuestions[0];
    const firstQuestionCode = firstDependencyQuestion?.code ?? '';
    const firstExpectedValue =
      firstDependencyQuestion?.question_type === 'boolean'
        ? 'true'
        : firstDependencyQuestion?.options?.[0]?.value ?? '';

    updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
      ...question,
      visibility_rules: [
        ...(question.visibility_rules ?? []),
        {
          id: createTempId(),
          question_id: question.id,
          depends_on_question_id: createTempId(),
          operator: 'equals',
          expected_value: firstExpectedValue,
          question_code: question.code,
          depends_on_question_code: firstQuestionCode,
        },
      ],
    }));
  };

  const handleDeleteVisibilityRule = (ruleId: number) => {
    if (!selectedStep || !selectedQuestion) return;

    updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
      ...question,
      visibility_rules: (question.visibility_rules ?? []).filter((rule) => rule.id !== ruleId),
    }));
  };

  const handleAddAnswerContext = () => {
    if (!selectedStep || !selectedQuestion) return;

    updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
      ...question,
      answer_contexts: [...(question.answer_contexts ?? []), createEmptyAnswerContext(question)],
    }));
  };

  const handleDeleteAnswerContext = (contextId: number) => {
    if (!selectedStep || !selectedQuestion) return;

    updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
      ...question,
      answer_contexts: (question.answer_contexts ?? []).filter((context) => context.id !== contextId),
    }));
  };

  const handleAddCatalogMitigation = () => {
    if (!selectedCatalogThreat) return;

    setSelectedCatalogThreat((previous) =>
      previous
        ? {
            ...previous,
            mitigations: [...previous.mitigations, createEmptyCatalogMitigation(previous.id_menace)],
          }
        : previous
    );
  };

  const handleDeleteCatalogMitigation = (mitigationId: number) => {
    setSelectedCatalogThreat((previous) =>
      previous
        ? {
            ...previous,
            mitigations: previous.mitigations.filter((mitigation) => mitigation.id_mitigation !== mitigationId),
          }
        : previous
    );
  };

  const handleAddCatalogScenario = () => {
    if (!selectedCatalogThreat) return;

    setSelectedCatalogThreat((previous) =>
      previous
        ? {
            ...previous,
            scenarios: [...previous.scenarios, createEmptyCatalogScenario(previous.id_menace)],
          }
        : previous
    );
  };

  const handleDeleteCatalogScenario = (scenarioId: number) => {
    setSelectedCatalogThreat((previous) =>
      previous
        ? {
            ...previous,
            scenarios: previous.scenarios.filter((scenario) => scenario.id_scenario !== scenarioId),
          }
        : previous
    );
  };

  const handleAddCatalogReference = () => {
    const firstReference = catalogReferences[0];
    setSelectedCatalogThreat((previous) =>
      previous
        ? {
            ...previous,
            references: firstReference
              ? [...previous.references, { ...firstReference }]
              : previous.references,
          }
        : previous
    );
  };

  const handleDeleteCatalogReference = (referenceId: number) => {
    setSelectedCatalogThreat((previous) =>
      previous
        ? {
            ...previous,
            references: previous.references.filter((reference) => reference.id_reference !== referenceId),
          }
        : previous
    );
  };

  const resetReferenceForm = () => {
    setReferenceForm({
      id_reference: null,
      reference_menace: '',
      nom_reference: '',
      lien: '',
    });
  };

  const resetInternalSolutionForm = () => {
    setInternalSolutionForm({
      id_solution: null,
      nom_solution: '',
      type_solution: '',
      editeur_solution: '',
      usage_securite: '',
      description_solution: '',
      actif: true,
    });
  };

  const handleEditReferenceRecord = (reference: CatalogReference) => {
    setReferenceForm({
      id_reference: reference.id_reference,
      reference_menace: reference.reference_menace,
      nom_reference: reference.nom_reference,
      lien: reference.lien ?? '',
    });
    setActiveSection('references');
  };

  const handleEditInternalSolution = (solution: InternalSecuritySolution) => {
    setInternalSolutionForm({
      id_solution: solution.id_solution,
      nom_solution: solution.nom_solution,
      type_solution: solution.type_solution,
      editeur_solution: solution.editeur_solution ?? '',
      usage_securite: solution.usage_securite ?? '',
      description_solution: solution.description_solution ?? '',
      actif: solution.actif,
    });
    setActiveSection('internal_solutions');
  };

  const handleSaveReferenceRecord = async () => {
    if (!referenceForm.reference_menace.trim() || !referenceForm.nom_reference.trim()) {
      const message = 'Le code reference et le nom de la source sont obligatoires.';
      setErrorMessage(message);
      await showErrorAlert('Champs obligatoires', message);
      return;
    }

    const duplicateReference = catalogReferences.find((reference) => {
      if (referenceForm.id_reference != null && reference.id_reference === referenceForm.id_reference) {
        return false;
      }

      return (
        normalizeAdminText(reference.reference_menace) ===
          normalizeAdminText(referenceForm.reference_menace) ||
        (
          normalizeAdminText(reference.nom_reference) ===
            normalizeAdminText(referenceForm.nom_reference) &&
          normalizeAdminText(reference.lien) === normalizeAdminText(referenceForm.lien)
        )
      );
    });

    if (duplicateReference) {
      const message = 'Cette référence existe déjà dans le catalogue.';
      setErrorMessage(message);
      await showInfoAlert('Référence déjà existante', message);
      return;
    }

    try {
      setErrorMessage('');
      const payload = {
        reference_menace: referenceForm.reference_menace.trim(),
        nom_reference: referenceForm.nom_reference.trim(),
        lien: referenceForm.lien.trim() || null,
      };

      if (referenceForm.id_reference == null) {
        await createCatalogReference(payload);
      } else {
        await updateCatalogReferenceRecord(referenceForm.id_reference, payload);
      }

      await refreshCatalogReferences();
      await refreshCatalogThreats(selectedCatalogThreatId);
      await refreshAuditTrailEntries();
      resetReferenceForm();
      setCatalogStatusMessage('Reference enregistree avec succes.');
      await showSuccessAlert('Référence enregistrée', 'L’opération a été effectuée avec succès.');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Erreur lors de la sauvegarde de la reference.';
      setErrorMessage(message);
      await showErrorAlert('Sauvegarde impossible', message);
    }
  };

  const handleDeleteReferenceRecord = async (referenceId: number) => {
    const confirmed = await showConfirmAlert({
      title: 'Supprimer cette référence ?',
      text: 'Cette action est irréversible.',
      confirmButtonText: 'Supprimer',
    });
    if (!confirmed) return;

    try {
      setErrorMessage('');
      await deleteCatalogReferenceRecord(referenceId);
      await refreshCatalogReferences();
      await refreshCatalogThreats(selectedCatalogThreatId);
      await refreshAuditTrailEntries();
      if (referenceForm.id_reference === referenceId) {
        resetReferenceForm();
      }
      setCatalogStatusMessage('Reference supprimee.');
      await showSuccessAlert('Référence supprimée', 'La référence a été supprimée.');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Erreur lors de la suppression de la reference.';
      setErrorMessage(message);
      await showErrorAlert('Suppression impossible', message);
    }
  };

  const handleSaveInternalSolution = async () => {
    if (!internalSolutionForm.nom_solution.trim() || !internalSolutionForm.type_solution.trim()) {
      const message = 'Le nom de la solution et son type sont obligatoires.';
      setErrorMessage(message);
      await showErrorAlert('Champs obligatoires', message);
      return;
    }

    const duplicateSolution = internalSecuritySolutions.find((solution) => {
      if (internalSolutionForm.id_solution != null && solution.id_solution === internalSolutionForm.id_solution) {
        return false;
      }

      return (
        normalizeAdminText(solution.nom_solution) ===
          normalizeAdminText(internalSolutionForm.nom_solution) &&
        normalizeAdminText(solution.type_solution) ===
          normalizeAdminText(internalSolutionForm.type_solution)
      );
    });

    if (duplicateSolution) {
      const message = 'Cette solution interne existe déjà pour ce type.';
      setErrorMessage(message);
      await showInfoAlert('Solution déjà existante', message);
      return;
    }

    try {
      setErrorMessage('');
      const payload = {
        nom_solution: internalSolutionForm.nom_solution.trim(),
        type_solution: internalSolutionForm.type_solution.trim(),
        editeur_solution: internalSolutionForm.editeur_solution.trim() || null,
        usage_securite: internalSolutionForm.usage_securite.trim() || null,
        description_solution: internalSolutionForm.description_solution.trim() || null,
        actif: internalSolutionForm.actif,
      };

      if (internalSolutionForm.id_solution == null) {
        await createInternalSecuritySolution(payload);
      } else {
        await updateInternalSecuritySolution(internalSolutionForm.id_solution, payload);
      }

      await refreshInternalSecuritySolutions();
      await refreshAuditTrailEntries();
      resetInternalSolutionForm();
      setCatalogStatusMessage('Solution interne enregistree avec succes.');
      await showSuccessAlert('Solution enregistrée', 'L’opération a été effectuée avec succès.');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Erreur lors de la sauvegarde de la solution interne.';
      setErrorMessage(message);
      await showErrorAlert('Sauvegarde impossible', message);
    }
  };

  const handleDeleteInternalSolution = async (solutionId: number) => {
    const confirmed = await showConfirmAlert({
      title: 'Supprimer cette solution interne ?',
      text: 'Cette action est irréversible.',
      confirmButtonText: 'Supprimer',
    });
    if (!confirmed) return;

    try {
      setErrorMessage('');
      await deleteInternalSecuritySolution(solutionId);
      await refreshInternalSecuritySolutions();
      await refreshAuditTrailEntries();
      if (internalSolutionForm.id_solution === solutionId) {
        resetInternalSolutionForm();
      }
      setCatalogStatusMessage('Solution interne supprimee.');
      await showSuccessAlert('Solution supprimée', 'La solution interne a été supprimée.');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Erreur lors de la suppression de la solution interne.';
      setErrorMessage(message);
      await showErrorAlert('Suppression impossible', message);
    }
  };

  const handleSave = async () => {
    if (!selectedQuestionnaire) return;

    try {
      setIsSaving(true);
      setErrorMessage('');

      const selectedStepCode = selectedStep?.code ?? null;
      const selectedQuestionCode = selectedQuestion?.code ?? null;
      const payload = buildQuestionnairePayload(selectedQuestionnaire);
      const isCreating = selectedQuestionnaireId === null;
      const response = await fetch(
        isCreating
          ? `${API_BASE_URL}/admin/questionnaires`
          : `${API_BASE_URL}/admin/questionnaires/${selectedQuestionnaireId}`,
        {
          method: isCreating ? 'POST' : 'PUT',
          headers: buildAuthHeaders(true),
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        throw new Error(errorBody?.detail || 'Impossible d’enregistrer le questionnaire.');
      }

      const saved = decorateQuestionnaire((await response.json()) as Questionnaire);
      const savedSelectedStep =
        saved.steps.find((step) => step.code === selectedStepCode) ?? saved.steps[0] ?? null;
      const savedSelectedQuestion =
        savedSelectedStep?.questions?.find((question) => question.code === selectedQuestionCode) ??
        savedSelectedStep?.questions?.[0] ??
        null;

      setSelectedQuestionnaire(saved);
      setSelectedQuestionnaireId(saved.id);
      await refreshQuestionnaires(saved.id);
      await refreshAuditTrailEntries();
      setSelectedStepId(savedSelectedStep?.id ?? null);
      setSelectedQuestionId(savedSelectedQuestion?.id ?? null);
      await showSuccessAlert('Questionnaire enregistré', 'L’opération a été effectuée avec succès.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur lors de la sauvegarde.';
      setErrorMessage(message);
      await showErrorAlert('Sauvegarde impossible', message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteQuestionnaire = async () => {
    if (!selectedQuestionnaire || selectedQuestionnaireId === null) return;

    const confirmed = await showConfirmAlert({
      title: `Supprimer le questionnaire ${selectedQuestionnaire.name} ?`,
      text: 'Cette action est irréversible.',
      confirmButtonText: 'Supprimer',
    });
    if (!confirmed) return;

    try {
      setIsSaving(true);
      const response = await fetch(`${API_BASE_URL}/admin/questionnaires/${selectedQuestionnaireId}`, {
        method: 'DELETE',
        headers: buildAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error('Impossible de supprimer le questionnaire.');
      }

      setSelectedQuestionnaire(null);
      setSelectedQuestionnaireId(null);
      setSelectedStepId(null);
      setSelectedQuestionId(null);

      const nextQuestionnaireId = questionnaires.find(
        (questionnaire) => questionnaire.id !== selectedQuestionnaireId
      )?.id;
      await refreshQuestionnaires(nextQuestionnaireId ?? null);
      await refreshAuditTrailEntries();
      await showSuccessAlert('Questionnaire supprimé', 'Le questionnaire a été supprimé.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur lors de la suppression.';
      setErrorMessage(message);
      await showErrorAlert('Suppression impossible', message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveCatalogThreat = async () => {
    if (!selectedCatalogThreat) return;

    const duplicateThreat = catalogThreats.find((threat) => {
      if (selectedCatalogThreatId != null && threat.id_menace === selectedCatalogThreatId) {
        return false;
      }

      return (
        normalizeAdminText(threat.nom_menace) ===
        normalizeAdminText(selectedCatalogThreat.nom_menace)
      );
    });

    if (duplicateThreat) {
      const message = 'Une menace avec le même nom existe déjà dans le catalogue.';
      setErrorMessage(message);
      await showInfoAlert('Menace déjà existante', message);
      return;
    }

    try {
      setIsSavingCatalogThreat(true);
      setErrorMessage('');
      setCatalogStatusMessage('');

      const payload = buildCatalogThreatPayload(selectedCatalogThreat);
      const isCreating = selectedCatalogThreatId === null;
      const response = await fetch(
        isCreating
          ? `${API_BASE_URL}/admin/catalog/threats`
          : `${API_BASE_URL}/admin/catalog/threats/${selectedCatalogThreatId}`,
        {
          method: isCreating ? 'POST' : 'PUT',
          headers: buildAuthHeaders(true),
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        throw new Error(errorBody?.detail || 'Impossible d’enregistrer la menace.');
      }

      const saved = (await response.json()) as CatalogThreat;
      setSelectedCatalogThreat(saved);
      setSelectedCatalogThreatId(saved.id_menace);
      await refreshCatalogThreats(saved.id_menace);
      await refreshAuditTrailEntries();
      setCatalogStatusMessage('Menace enregistree avec succes.');
      await showSuccessAlert('Menace enregistrée', 'L’opération a été effectuée avec succès.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur lors de la sauvegarde.';
      setErrorMessage(message);
      await showErrorAlert('Sauvegarde impossible', message);
    } finally {
      setIsSavingCatalogThreat(false);
    }
  };

  const handleDeleteCatalogThreat = async () => {
    if (!selectedCatalogThreat || selectedCatalogThreatId === null) return;

    const confirmed = await showConfirmAlert({
      title: `Supprimer la menace ${selectedCatalogThreat.nom_menace} ?`,
      text: 'Cette action est irréversible.',
      confirmButtonText: 'Supprimer',
    });
    if (!confirmed) return;

    try {
      setIsSavingCatalogThreat(true);
      setErrorMessage('');
      setCatalogStatusMessage('');

      const response = await fetch(`${API_BASE_URL}/admin/catalog/threats/${selectedCatalogThreatId}`, {
        method: 'DELETE',
        headers: buildAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error('Impossible de supprimer la menace.');
      }

      const nextThreatId = catalogThreats.find((threat) => threat.id_menace !== selectedCatalogThreatId)?.id_menace;
      setSelectedCatalogThreat(null);
      setSelectedCatalogThreatId(null);
      await refreshCatalogThreats(nextThreatId ?? null);
      await refreshAuditTrailEntries();
      setCatalogStatusMessage('Menace supprimee.');
      await showSuccessAlert('Menace supprimée', 'La menace a été supprimée.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur lors de la suppression.';
      setErrorMessage(message);
      await showErrorAlert('Suppression impossible', message);
    } finally {
      setIsSavingCatalogThreat(false);
    }
  };

  const handleTriggerCatalogRefresh = async () => {
    try {
      setIsSavingCatalogThreat(true);
      setErrorMessage('');
      setCatalogStatusMessage('');

      const response = await fetch(`${API_BASE_URL}/admin/catalog/threats/refresh`, {
        method: 'POST',
        headers: buildAuthHeaders(),
      });

      if (!response.ok) {
        throw new Error('Impossible de lancer la mise a jour du catalogue.');
      }

      const data = (await response.json()) as { message?: string };
      setCatalogStatusMessage(
        data.message ?? 'Le processus de mise a jour du catalogue a ete lance.'
      );
      await refreshAuditTrailEntries();
      await showSuccessAlert(
        'Mise à jour lancée',
        data.message ?? 'Le processus de mise à jour du catalogue a été lancé.'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur lors du lancement.';
      setErrorMessage(message);
      await showErrorAlert('Lancement impossible', message);
    } finally {
      setIsSavingCatalogThreat(false);
    }
  };

  const handleExportCatalogThreats = async () => {
    try {
      setIsExportingCatalog(true);
      setErrorMessage('');
      setCatalogStatusMessage('');

      const workbookBlob = await exportCatalogThreatWorkbook();
      const downloadUrl = window.URL.createObjectURL(workbookBlob);
      const link = document.createElement('a');

      link.href = downloadUrl;
      link.download = 'catalogue-menaces-awb.xlsx';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);

      setCatalogStatusMessage('Le catalogue des menaces a ete exporte avec succes.');
      await showSuccessAlert(
        'Export terminé',
        'Le catalogue des menaces a été exporté avec succès.'
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Erreur lors de l'export du catalogue.";
      setErrorMessage(message);
      await showErrorAlert('Export impossible', message);
    } finally {
      setIsExportingCatalog(false);
    }
  };

  const questionnaireCount = questionnaires.length;
  const catalogThreatCount = catalogThreats.length;

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      <Navbar
        activeSection={activeSection}
        onNavigate={setActiveSection}
        onLogout={onLogout}
        isApiConnected
        isDemoMode={false}
        currentUserName={currentUserName}
        notificationCenter={threatNotifications}
        navItems={[
          { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
          { key: 'catalog', label: 'Catalogue', icon: Database },
          { key: 'questionnaire', label: 'Questionnaires', icon: BookOpen },
          { key: 'internal_solutions', label: 'Solutions internes', icon: Settings2 },
          { key: 'cve_graph', label: 'Référentiel CVE', icon: Network },
          { key: 'references', label: 'Références', icon: LibraryBig },
          { key: 'traceability', label: 'Traçabilité', icon: History },
        ]}
      />

      <main className="mx-auto max-w-[1400px] px-4 pb-12 pt-36 sm:px-6 lg:px-8">
        {errorMessage && (
          <div className="mb-6 rounded-2xl border border-red-200 bg-white px-4 py-3 text-sm text-red-600 shadow-sm">
            {errorMessage}
          </div>
        )}

        {activeSection === 'dashboard' && (
          <>
            <AdminHeader
              eyebrow="Admin Workspace"
              title="Dashboard admin"
              description="Vue d’ensemble des questionnaires, étapes et questions gérées."
            />

            <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4 mb-6">
              <StatCard
                label="Questionnaires"
                value={String(questionnaireCount)}
                icon={<BookOpen />}
                tone="orange"
              />
              <StatCard
                label="Questions actives"
                value={String(dashboardStats.totalQuestions)}
                icon={<Database />}
                tone="slate"
              />
              <StatCard
                label="Questionnaires actifs"
                value={String(dashboardStats.activeQuestionnaires)}
                icon={<ShieldAlert />}
                tone="emerald"
              />
              <StatCard
                label="Menaces catalogue"
                value={String(catalogDashboardStats.totalThreats)}
                icon={<ShieldAlert />}
                tone="slate"
              />
            </div>

            <div className="grid grid-cols-1 gap-5 md:grid-cols-3 xl:grid-cols-4">
              <StatCard
                label="Total scenarios"
                value={String(catalogDashboardStats.totalScenarios)}
                icon={<Database />}
                tone="orange"
              />
              <StatCard
                label="Total mitigations"
                value={String(catalogDashboardStats.totalMitigations)}
                icon={<Settings2 />}
                tone="emerald"
              />
              <StatCard
                label="Références uniques"
                value={String(referenceStats.totalUniqueReferences)}
                icon={<LibraryBig />}
                tone="slate"
              />
              <StatCard
                label="Total etapes"
                value={String(dashboardStats.totalSteps)}
                icon={<BookOpen />}
                tone="orange"
              />
            </div>

            <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[1.15fr_0.85fr]">
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="mb-5">
                  <h2 className="text-xl font-bold text-slate-900">Repartition des references</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Nombre de menaces rattachees a chaque referentiel documentaire du catalogue.
                  </p>
                </div>

                {catalogReferenceGroups.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
                    Aucune reference disponible.
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-slate-200">
                    <div className="grid grid-cols-[minmax(0,2fr)_auto] gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <span>Nom source</span>
                      <span>Nombre</span>
                    </div>
                    <div className="divide-y divide-slate-200">
                      {catalogReferenceGroups.map((group) => (
                        <div
                          key={group.normalized_name}
                          className="grid grid-cols-[minmax(0,2fr)_auto] gap-4 px-5 py-4 text-sm"
                        >
                          <p className="truncate font-semibold text-slate-900">{group.display_name}</p>
                          <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white">
                            {group.code_count}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 gap-5">
                <StatCard
                  label="Codes references"
                  value={String(catalogReferences.length)}
                  icon={<Network />}
                  tone="orange"
                />
                <StatCard
                  label="Source dominante"
                  value={String(referenceStats.topReference?.threatCount ?? 0)}
                  icon={<Link2 />}
                  tone="emerald"
                />
                <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <p className="text-sm font-medium text-slate-500">Nom de source</p>
                  <p className="mt-2 text-2xl font-bold text-slate-900">
                    {referenceStats.topReference?.label || 'N/A'}
                  </p>
                </div>
              </div>
            </div>
          </>
        )}

        {activeSection === 'catalog' && (
          <>
            <AdminHeader
              eyebrow="Threat Catalog"
              title="Gestion du catalogue"
              description="Parcourez, corrigez et enrichissez le catalogue des menaces, avec un espace prepare pour la mise a jour automatique."
              action={
                <button
                  onClick={() => void handleExportCatalogThreats()}
                  disabled={isExportingCatalog || catalogThreats.length === 0}
                  className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  <Download className="h-4 w-4" />
                  {isExportingCatalog ? 'Export en cours...' : 'Exporter tout le catalogue'}
                </button>
              }
            />

            {catalogStatusMessage && (
              <div className="mb-6 rounded-2xl border border-emerald-200 bg-white px-4 py-3 text-sm text-emerald-700 shadow-sm">
                {catalogStatusMessage}
              </div>
            )}

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
              <aside className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Menaces</h2>
                    <p className="text-sm text-slate-500">
                      {isLoadingCatalogThreats
                        ? 'Chargement...'
                        : `${filteredCatalogThreats.length} / ${catalogThreatCount} menace(s)`}
                    </p>
                  </div>

                  <button
                    onClick={handleCreateCatalogThreat}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500 text-white transition hover:bg-orange-600"
                    title="Ajouter une menace"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>

                <div className="mb-4">
                  <input
                    type="text"
                    value={catalogThreatSearch}
                    onChange={(event) => setCatalogThreatSearch(event.target.value)}
                    placeholder="Rechercher une menace..."
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-orange-400 focus:bg-white focus:outline-none"
                  />
                </div>

                <div className="space-y-2">
                  {filteredCatalogThreats.map((threat) => (
                    <button
                      key={threat.id_menace}
                      onClick={() => handleSelectCatalogThreat(threat.id_menace)}
                      className={`w-full rounded-2xl px-4 py-3 text-left transition-all ${
                        selectedCatalogThreatId === threat.id_menace
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-50 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{threat.nom_menace}</p>
                          <p
                            className={`mt-1 text-xs ${
                              selectedCatalogThreatId === threat.id_menace ? 'text-slate-300' : 'text-slate-400'
                            }`}
                          >
                            {threat.reference_menace || 'Reference non definie'}
                          </p>
                        </div>

                        <span
                          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                            selectedCatalogThreatId === threat.id_menace
                              ? 'bg-white/10 text-white'
                              : 'bg-white text-slate-500'
                          }`}
                        >
                          {threat.mitigation_count + threat.scenario_count + threat.reference_count}
                        </span>
                      </div>

                      <p
                        className={`mt-3 text-xs ${
                          selectedCatalogThreatId === threat.id_menace ? 'text-slate-300' : 'text-slate-500'
                        }`}
                      >
                        {summarizeText(threat.description, 'Aucune description pour cette menace.')}
                      </p>
                    </button>
                  ))}

                  {!isLoadingCatalogThreats && catalogThreats.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                      Aucune menace dans le catalogue.
                    </div>
                  )}

                  {!isLoadingCatalogThreats &&
                    catalogThreats.length > 0 &&
                    filteredCatalogThreats.length === 0 && (
                      <div className="rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                        Aucune menace ne correspond à votre recherche.
                      </div>
                    )}
                </div>
              </aside>

              <section className="space-y-6">
                <CollapsePanel
                  title={selectedCatalogThreat?.nom_menace ?? 'Selectionnez une menace'}
                  subtitle="Actions principales sur la menace sélectionnée."
                  defaultOpen
                >
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                    <div>
                      <p className="text-sm text-slate-500">
                        Gerez les descriptions, scenarios, mitigations et references associees.
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-3">
                      <button
                        onClick={handleCreateCatalogThreat}
                        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                      >
                        <Plus className="h-4 w-4" />
                        Nouvelle menace
                      </button>

                      <button
                        onClick={handleTriggerCatalogRefresh}
                        disabled={isSavingCatalogThreat}
                        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RefreshCw className="h-4 w-4" />
                        Lancer mise a jour
                      </button>

                      <button
                        onClick={handleSaveCatalogThreat}
                        disabled={!selectedCatalogThreat || isSavingCatalogThreat}
                        className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Save className="h-4 w-4" />
                        {isSavingCatalogThreat ? 'Enregistrement...' : 'Enregistrer'}
                      </button>

                      <button
                        onClick={handleDeleteCatalogThreat}
                        disabled={!selectedCatalogThreat || selectedCatalogThreatId === null || isSavingCatalogThreat}
                        className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" />
                        Supprimer
                      </button>
                    </div>
                  </div>
                </CollapsePanel>

                {isLoadingCatalogThreat && (
                  <div className="rounded-3xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
                    Chargement de la menace selectionnee...
                  </div>
                )}

                {selectedCatalogThreat && !isLoadingCatalogThreat && (
                  <>
                    <CollapsePanel
                      title="Fiche menace"
                      subtitle="Corrigez les metadonnees principales avant d’ajouter les details techniques."
                      badge={`${selectedCatalogThreat.references.length} référence(s)`}
                      defaultOpen
                    >
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <Field
                          label="Nom de la menace"
                          value={selectedCatalogThreat.nom_menace}
                          onChange={(value) => updateCatalogThreatField('nom_menace', value)}
                        />
                        <Field
                          label="Code reference principale"
                          value={selectedCatalogThreat.reference_menace ?? ''}
                          onChange={(value) => updateCatalogThreatField('reference_menace', value)}
                        />
                      </div>

                      <div className="mt-4">
                        <TextAreaField
                          label="Description"
                          value={selectedCatalogThreat.description ?? ''}
                          onChange={(value) => updateCatalogThreatField('description', value)}
                          rows={5}
                        />
                      </div>

                      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
                        <MetricPill label="Mitigations" value={String(selectedCatalogThreat.mitigations.length)} />
                        <MetricPill label="Scenarios" value={String(selectedCatalogThreat.scenarios.length)} />
                        <MetricPill label="References" value={String(selectedCatalogThreat.references.length)} />
                      </div>
                    </CollapsePanel>

                    <div className="space-y-4">
                      <CollapsePanel
                        title="Scenarios d’attaque"
                        subtitle="Decrivez comment la menace peut se materialiser."
                        badge={`${selectedCatalogThreat.scenarios.length} scénario(s)`}
                        defaultOpen
                        action={
                          <button
                            onClick={handleAddCatalogScenario}
                            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                          >
                            <Plus className="h-4 w-4" />
                            Ajouter
                          </button>
                        }
                      >
                        <div className="space-y-4">
                          {selectedCatalogThreat.scenarios.map((scenario) => (
                            <div key={scenario.id_scenario} className="rounded-2xl border border-slate-200 p-4">
                              <TextAreaField
                                label="Description"
                                value={scenario.description_scenario}
                                onChange={(value) =>
                                  updateCatalogScenario(scenario.id_scenario, (current) => ({
                                    ...current,
                                    description_scenario: value,
                                  }))
                                }
                                rows={3}
                              />

                              <div className="mt-3 flex justify-end">
                                <button
                                  onClick={() => handleDeleteCatalogScenario(scenario.id_scenario)}
                                  className="rounded-lg p-2 text-red-500 transition hover:bg-red-50"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
                            </div>
                          ))}

                          {selectedCatalogThreat.scenarios.length === 0 && (
                            <p className="rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                              Aucun scenario defini.
                            </p>
                          )}
                        </div>
                      </CollapsePanel>

                      <CollapsePanel
                        title="Mesures de mitigation"
                        subtitle="Ajoutez les controles ou actions de reduction du risque."
                        badge={`${selectedCatalogThreat.mitigations.length} mitigation(s)`}
                        defaultOpen
                        action={
                          <button
                            onClick={handleAddCatalogMitigation}
                            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                          >
                            <Plus className="h-4 w-4" />
                            Ajouter
                          </button>
                        }
                      >
                        <div className="space-y-4">
                          {selectedCatalogThreat.mitigations.map((mitigation) => (
                            <div key={mitigation.id_mitigation} className="rounded-2xl border border-slate-200 p-4">
                              <TextAreaField
                                label="Description"
                                value={mitigation.description_mitigation}
                                onChange={(value) =>
                                  updateCatalogMitigation(mitigation.id_mitigation, (current) => ({
                                    ...current,
                                    description_mitigation: value,
                                  }))
                                }
                                rows={3}
                              />

                              <div className="mt-3 flex justify-end">
                                <button
                                  onClick={() => handleDeleteCatalogMitigation(mitigation.id_mitigation)}
                                  className="rounded-lg p-2 text-red-500 transition hover:bg-red-50"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
                            </div>
                          ))}

                          {selectedCatalogThreat.mitigations.length === 0 && (
                            <p className="rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                              Aucune mitigation definie.
                            </p>
                          )}
                        </div>
                      </CollapsePanel>

                      <CollapsePanel
                        title="References associees"
                        subtitle="Le code reste libre par menace, mais le nom de source se choisit depuis la liste maitre."
                        badge={`${selectedCatalogThreat.references.length} référence(s)`}
                        defaultOpen
                        action={
                          <button
                            onClick={handleAddCatalogReference}
                            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                          >
                            <Plus className="h-4 w-4" />
                            Ajouter reference
                          </button>
                        }
                      >
                      <div className="space-y-4">
                        {selectedCatalogThreat.references.map((reference) => (
                          <div key={reference.id_reference} className="rounded-2xl border border-slate-200 p-4">
                            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                              <Field
                                label="Code reference"
                                value={reference.reference_menace}
                                onChange={(value) =>
                                  updateCatalogReference(reference.id_reference, (current) => ({
                                    ...current,
                                    reference_menace: value,
                                  }))
                                }
                              />
                              <Field
                                label="Nom de la source"
                                value={reference.nom_reference}
                                onChange={(value) =>
                                  updateCatalogReference(reference.id_reference, (current) => {
                                    const selectedGroup = catalogReferenceGroups.find(
                                      (group) => group.display_name === value
                                    );
                                    const sampleReference = catalogReferences.find(
                                      (item) => item.nom_reference === value
                                    );

                                    return {
                                      ...current,
                                      nom_reference: value,
                                      lien: sampleReference?.lien ?? current.lien,
                                      id_reference:
                                        selectedGroup && sampleReference
                                          ? sampleReference.id_reference
                                          : current.id_reference,
                                    };
                                  })
                                }
                                options={catalogReferenceGroups.map((group) => group.display_name)}
                              />
                              <Field
                                label="Lien"
                                value={reference.lien ?? ''}
                                onChange={(value) =>
                                  updateCatalogReference(reference.id_reference, (current) => ({
                                    ...current,
                                    lien: value,
                                  }))
                                }
                              />
                            </div>

                            <div className="mt-3 flex justify-end">
                              <button
                                onClick={() => handleDeleteCatalogReference(reference.id_reference)}
                                className="rounded-lg p-2 text-red-500 transition hover:bg-red-50"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        ))}

                        {selectedCatalogThreat.references.length === 0 && (
                          <p className="rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                            Aucune reference associee.
                          </p>
                        )}
                      </div>
                      </CollapsePanel>
                    </div>
                  </>
                )}
              </section>
            </div>
          </>
        )}

        {activeSection === 'questionnaire' && (
          <>
            <AdminHeader
              eyebrow="Questionnaire Builder"
              title="Gestion du questionnaire"
              description="Parcourez, corrigez et enrichissez les questionnaires, et leurs étapes et questions associées"
            />

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_1fr]">
              <aside>
                <CollapsePanel
                  title="Questionnaires"
                  subtitle={isLoadingQuestionnaires ? 'Chargement...' : `${questionnaireCount} élément(s)`}
                  defaultOpen
                  action={
                    <button
                      onClick={handleCreateQuestionnaire}
                      className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white transition hover:bg-slate-700"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  }
                >
                  <div className="space-y-3">
                    {questionnaires.map((questionnaire) => (
                      <button
                        key={questionnaire.id}
                        onClick={() => void handleSelectQuestionnaire(questionnaire.id)}
                        className={`w-full rounded-2xl border p-4 text-left transition-all ${
                          selectedQuestionnaireId === questionnaire.id
                            ? 'border-orange-300 bg-orange-50'
                            : 'border-slate-200 bg-white hover:bg-slate-50'
                        }`}
                      >
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <span className="font-semibold text-slate-900">{questionnaire.name}</span>
                          <span
                            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                              questionnaire.is_active
                                ? 'bg-emerald-100 text-emerald-700'
                                : 'bg-slate-100 text-slate-500'
                            }`}
                          >
                            {questionnaire.is_active ? 'Actif' : 'Brouillon'}
                          </span>
                        </div>

                        <p className="text-xs text-slate-500">
                          {questionnaire.code} · v{questionnaire.version} · {questionnaire.status}
                        </p>
                      </button>
                    ))}

                    {!isLoadingQuestionnaires && questionnaires.length === 0 && (
                      <div className="rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                        Aucun questionnaire trouvé.
                      </div>
                    )}
                  </div>
                </CollapsePanel>
              </aside>

              <section className="space-y-6">
                <CollapsePanel
                  title="Fiche questionnaire"
                  subtitle="Paramètres principaux du questionnaire sélectionné."
                  defaultOpen
                >
                  <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
                    <div className="max-w-3xl">
                      <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-orange-100 px-3 py-1 text-xs font-semibold text-orange-700">
                        <BookOpen className="h-3.5 w-3.5" />
                        Questionnaire 
                      </div>

                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <Field
                          label="Code"
                          value={selectedQuestionnaire?.code ?? ''}
                          onChange={(value) => updateQuestionnaireField('code', value)}
                          disabled={!selectedQuestionnaire}
                        />
                        <Field
                          label="Nom"
                          value={selectedQuestionnaire?.name ?? ''}
                          onChange={(value) => updateQuestionnaireField('name', value)}
                          disabled={!selectedQuestionnaire}
                        />
                        <Field
                          label="Version"
                          value={selectedQuestionnaire ? String(selectedQuestionnaire.version) : ''}
                          onChange={(value) =>
                            updateQuestionnaireField('version', Number.parseInt(value || '0', 10) || 1)
                          }
                          disabled={!selectedQuestionnaire}
                        />
                        <Field
                          label="Statut"
                          value={selectedQuestionnaire?.status ?? ''}
                          onChange={(value) => updateQuestionnaireField('status', value)}
                          disabled={!selectedQuestionnaire}
                        />
                      </div>

                      <label className="mt-4 flex items-center gap-3 text-sm font-semibold text-slate-700">
                        <input
                          type="checkbox"
                          checked={selectedQuestionnaire?.is_active ?? false}
                          onChange={(event) => updateQuestionnaireField('is_active', event.target.checked)}
                          disabled={!selectedQuestionnaire}
                          className="h-4 w-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500"
                        />
                        {' '}
                        Questionnaire actif
                      </label>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={handleSave}
                        disabled={!selectedQuestionnaire || isSaving}
                        className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Save className="h-4 w-4" />
                        {isSaving ? 'Sauvegarde...' : 'Enregistrer'}
                      </button>

                      <button
                        onClick={handleDeleteQuestionnaire}
                        disabled={!selectedQuestionnaire || selectedQuestionnaireId === null || isSaving}
                        className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Trash2 className="h-4 w-4" />
                        Supprimer
                      </button>
                    </div>
                  </div>
                </CollapsePanel>

                {isLoadingQuestionnaire && (
                  <div className="rounded-3xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
                    Chargement du questionnaire sélectionné...
                  </div>
                )}

                {selectedQuestionnaire && !isLoadingQuestionnaire && (
                  <div className="grid grid-cols-1 gap-6 xl:grid-cols-[280px_1fr]">
                    <CollapsePanel
                      title="Étapes"
                      subtitle="Organisation générale du questionnaire."
                      badge={`${selectedQuestionnaire.steps.length} étape(s)`}
                      defaultOpen
                      action={
                        <button
                          onClick={handleAddStep}
                          className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100"
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      }
                    >
                      <div className="space-y-2">
                        {selectedQuestionnaire.steps.map((step) => (
                          <div key={step.id} className="flex gap-2">
                            <button
                              onClick={() => {
                                setSelectedStepId(step.id);
                                setSelectedQuestionId(step.questions?.[0]?.id ?? null);
                              }}
                              className={`flex-1 rounded-2xl px-4 py-3 text-left transition-all ${
                                selectedStepId === step.id
                                  ? 'bg-slate-900 text-white'
                                  : 'bg-slate-50 text-slate-700 hover:bg-slate-100'
                              }`}
                            >
                              <p className="text-sm font-semibold">{step.title}</p>
                              <p className={`mt-1 text-xs ${selectedStepId === step.id ? 'text-slate-300' : 'text-slate-400'}`}>
                                ordre {step.step_order}
                              </p>
                            </button>

                            <button
                              onClick={() => handleDeleteStep(step.id)}
                              className="rounded-2xl border border-slate-200 bg-white px-3 text-slate-500 transition hover:bg-slate-50"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        ))}

                        {selectedQuestionnaire.steps.length === 0 && (
                          <div className="rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                            Aucune étape.
                          </div>
                        )}
                      </div>
                    </CollapsePanel>

                    <div className="space-y-6">
                      <CollapsePanel
                        title={selectedStep?.title ?? 'Sélectionnez une étape'}
                        subtitle="Questions et options dynamiques."
                        defaultOpen
                        action={
                          <button
                            onClick={handleAddQuestion}
                            disabled={!selectedStep}
                            className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Plus className="h-4 w-4" />
                            Ajouter question
                          </button>
                        }
                      >
                        <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                          <div />
                        </div>

                        {selectedStep && (
                          <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-2">
                            <Field
                              label="Nom de l'étape"
                              value={selectedStep.title}
                              onChange={(value) =>
                                updateStep(selectedStep.id, (step) => ({
                                  ...step,
                                  title: value,
                                }))
                              }
                            />
                            <Field
                              label="Code étape"
                              value={selectedStep.code}
                              onChange={(value) =>
                                updateStep(selectedStep.id, (step) => ({
                                  ...step,
                                  code: value,
                                }))
                              }
                            />
                          </div>
                        )}

                        <div className="overflow-hidden rounded-2xl border border-slate-200">
                          <table className="w-full text-left text-sm">
                            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                              <tr>
                                <th className="px-4 py-3">Ordre</th>
                                <th className="px-4 py-3">Question</th>
                                <th className="px-4 py-3">Type</th>
                                <th className="px-4 py-3">Required</th>
                                <th className="px-4 py-3">Options</th>
                                <th className="px-4 py-3 text-right">Actions</th>
                              </tr>
                            </thead>

                            <tbody className="divide-y divide-slate-100 bg-white">
                              {(selectedStep?.questions ?? []).map((question) => (
                                <tr key={question.id} className="hover:bg-slate-50/70">
                                  <td className="px-4 py-4 font-mono text-slate-500">
                                    {question.display_order}
                                  </td>

                                  <td className="px-4 py-4">
                                    <button
                                      onClick={() => setSelectedQuestionId(question.id)}
                                      className="text-left"
                                    >
                                      <p className="font-semibold text-slate-900">{question.label}</p>
                                      <p className="mt-1 font-mono text-xs text-slate-400">
                                        {question.code}
                                      </p>
                                    </button>
                                  </td>

                                  <td className="px-4 py-4">
                                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                                      {question.question_type}
                                    </span>
                                  </td>

                                  <td className="px-4 py-4">
                                    {question.is_required ? (
                                      <span className="font-semibold text-emerald-600">Oui</span>
                                    ) : (
                                      <span className="text-slate-400">Non</span>
                                    )}
                                  </td>

                                  <td className="px-4 py-4 text-slate-500">
                                    {(question.options ?? []).length}
                                  </td>

                                  <td className="px-4 py-4">
                                    <div className="flex justify-end gap-2">
                                      <button
                                        onClick={() => setSelectedQuestionId(question.id)}
                                        className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100"
                                      >
                                        <Settings2 className="h-4 w-4" />
                                      </button>
                                      <button
                                        onClick={() => setSelectedQuestionId(question.id)}
                                        className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100"
                                      >
                                        <Edit3 className="h-4 w-4" />
                                      </button>
                                      <button
                                        onClick={() => handleDeleteQuestion(question.id)}
                                        className="rounded-lg p-2 text-red-500 transition hover:bg-red-50"
                                      >
                                        <Trash2 className="h-4 w-4" />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              ))}

                              {(selectedStep?.questions ?? []).length === 0 && (
                                <tr>
                                  <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                                    Aucune question dans cette étape.
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </CollapsePanel>

                      {selectedQuestion && selectedStep && (
                        <CollapsePanel
                          title="Éditeur de question"
                          subtitle="Modification guidée de la question sélectionnée."
                          defaultOpen
                          action={
                            <button
                              onClick={handleAddVisibilityRule}
                              disabled={availableVisibilityQuestions.length === 0}
                              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <Plus className="h-4 w-4" />
                              Ajouter règle
                            </button>
                          }
                        >
                          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                            <div>
                              <p className="text-sm text-slate-500">
                                Modifiez le libellé, le type, les options et les règles de visibilité avec des choix assistés.
                              </p>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                            <Field
                              label="Code"
                              value={selectedQuestion.code}
                              onChange={(value) =>
                                updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
                                  ...question,
                                  code: value,
                                }))
                              }
                            />
                            <Field
                              label="Libellé"
                              value={selectedQuestion.label}
                              onChange={(value) =>
                                updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
                                  ...question,
                                  label: value,
                                }))
                              }
                            />
                            <Field
                              label="Aide"
                              value={selectedQuestion.aide ?? selectedQuestion.help_text ?? ''}
                              onChange={(value) =>
                                updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
                                  ...question,
                                  aide: value,
                                }))
                              }
                            />
                            <Field
                              label="Backend key"
                              value={selectedQuestion.backend_key ?? ''}
                              onChange={(value) =>
                                updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
                                  ...question,
                                  backend_key: value,
                                }))
                              }
                            />
                            <Field
                              label="Type"
                              value={selectedQuestion.question_type}
                              onChange={(value) =>
                                updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
                                  ...question,
                                  question_type: value as Question['question_type'],
                                }))
                              }
                              options={['boolean', 'select', 'text', 'textarea', 'multiselect']}
                            />
                            <OrderField
                              label="Ordre"
                              value={selectedQuestion.display_order}
                              onCommit={(value) =>
                                reorderQuestionDisplayOrder(
                                  selectedStep.id,
                                  selectedQuestion.id,
                                  value
                                )
                              }
                            />
                          </div>

                          <div className="mt-4 flex flex-wrap gap-4">
                            <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
                              <input
                                type="checkbox"
                                checked={selectedQuestion.is_required}
                                onChange={(event) =>
                                  updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
                                    ...question,
                                    is_required: event.target.checked,
                                  }))
                                }
                                className="h-4 w-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500"
                              />
                              {' '}
                              Obligatoire
                            </label>

                            <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
                              <input
                                type="checkbox"
                                checked={selectedQuestion.is_active}
                                onChange={(event) =>
                                  updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
                                    ...question,
                                    is_active: event.target.checked,
                                  }))
                                }
                                className="h-4 w-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500"
                              />
                              {' '}
                              Active
                            </label>

                            {selectedQuestion.question_type === 'boolean' && (
                              <label className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
                                <input
                                  type="checkbox"
                                  checked={selectedQuestion.send_if_true_only}
                                  onChange={(event) =>
                                    updateQuestion(selectedStep.id, selectedQuestion.id, (question) => ({
                                      ...question,
                                      send_if_true_only: event.target.checked,
                                    }))
                                  }
                                  className="h-4 w-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500"
                                />
                                {' '}
                                Envoyer uniquement si vrai
                              </label>
                            )}
                          </div>

                          <div className="mt-6 space-y-4">
                            {(selectedQuestion.question_type === 'select' ||
                              selectedQuestion.question_type === 'multiselect') && (
                              <CollapsePanel
                                title="Options"
                                subtitle="Un seul champ à saisir. La valeur technique est générée automatiquement."
                                badge={`${(selectedQuestion.options ?? []).length} élément(s)`}
                                defaultOpen
                                action={
                                  <button
                                    onClick={handleAddOption}
                                    className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                                  >
                                    <Plus className="h-3.5 w-3.5" />
                                    Ajouter
                                  </button>
                                }
                              >
                                <div className="space-y-3">
                                  {(selectedQuestion.options ?? []).map((option) => (
                                    <div
                                      key={option.id}
                                      className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4"
                                    >
                                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                        <div className="min-w-0 flex-1 space-y-2">
                                          <input
                                            value={option.label}
                                            onChange={(event) =>
                                              updateQuestion(selectedStep.id, selectedQuestion.id, (question) =>
                                                updateOptionInQuestion(question, option.id, 'label', event.target.value)
                                              )
                                            }
                                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm focus:border-orange-400 focus:outline-none"
                                            placeholder="Libellé visible"
                                          />
                                          <div className="inline-flex max-w-full items-center gap-2 rounded-full bg-slate-900 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
                                            <span className="text-white/70">Valeur générée</span>
                                            <span className="truncate">{option.value}</span>
                                          </div>
                                        </div>
                                        <button
                                          onClick={() => handleDeleteOption(option.id)}
                                          className="self-end rounded-lg px-2 py-2 text-red-500 transition hover:bg-red-50 md:self-center"
                                        >
                                          <Trash2 className="h-4 w-4" />
                                        </button>
                                      </div>

                                      <div className="mt-4 rounded-2xl border border-dashed border-slate-200 bg-white/80 p-4">
                                        <div className="mb-3 flex items-center justify-between gap-3">
                                          <div>
                                            <p className="text-sm font-semibold text-slate-900">
                                              Visibilite de l&apos;option
                                            </p>
                                            <p className="text-xs text-slate-500">
                                              Cette option peut dependre de la reponse a une autre question.
                                            </p>
                                          </div>
                                          <button
                                            onClick={() => handleAddOptionVisibilityRule(option.id)}
                                            disabled={availableVisibilityQuestions.length === 0}
                                            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                          >
                                            <Plus className="h-3.5 w-3.5" />
                                            Ajouter
                                          </button>
                                        </div>

                                        <div className="space-y-3">
                                          {(option.visibility_rules ?? []).map((rule, index) => (
                                            <div
                                              key={rule.id ?? index}
                                              className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4"
                                            >
                                              <div className="mb-3 flex items-center justify-between gap-3">
                                                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                                  Regle {index + 1}
                                                </div>
                                                <button
                                                  onClick={() => handleDeleteOptionVisibilityRule(option.id, rule.id)}
                                                  className="rounded-lg px-2 py-2 text-red-500 transition hover:bg-red-50"
                                                >
                                                  <Trash2 className="h-4 w-4" />
                                                </button>
                                              </div>

                                              <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
                                                <div className="min-w-0">
                                                  <Field
                                                    label="Question dependante"
                                                    value={rule.depends_on_question_code ?? ''}
                                                    onChange={(value) =>
                                                      updateQuestion(selectedStep.id, selectedQuestion.id, (question) => {
                                                        const nextExpectedValue = getExpectedValueOptions(value)[0] ?? '';
                                                        return updateOptionVisibilityRuleInQuestion(
                                                          updateOptionVisibilityRuleInQuestion(
                                                            question,
                                                            option.id,
                                                            index,
                                                            'depends_on_question_code',
                                                            value
                                                          ),
                                                          option.id,
                                                          index,
                                                          'expected_value',
                                                          nextExpectedValue
                                                        );
                                                      })
                                                    }
                                                    options={availableVisibilityQuestions.map((question) => question.code)}
                                                  />
                                                  {rule.depends_on_question_code && (
                                                    <p className="mt-2 rounded-xl bg-white px-3 py-2 text-xs leading-relaxed text-slate-500">
                                                      {getRuleQuestionByCode(rule.depends_on_question_code)?.label ?? 'Question non trouvee'}
                                                    </p>
                                                  )}
                                                </div>
                                                <div className="min-w-0">
                                                  <Field
                                                    label="Operateur"
                                                    value={rule.operator}
                                                    onChange={(value) =>
                                                      updateQuestion(selectedStep.id, selectedQuestion.id, (question) =>
                                                        updateOptionVisibilityRuleInQuestion(
                                                          question,
                                                          option.id,
                                                          index,
                                                          'operator',
                                                          value
                                                        )
                                                      )
                                                    }
                                                    options={['equals', 'not_equals']}
                                                  />
                                                </div>
                                                <div className="min-w-0">
                                                  <Field
                                                    label="Valeur attendue"
                                                    value={rule.expected_value}
                                                    onChange={(value) =>
                                                      updateQuestion(selectedStep.id, selectedQuestion.id, (question) =>
                                                        updateOptionVisibilityRuleInQuestion(
                                                          question,
                                                          option.id,
                                                          index,
                                                          'expected_value',
                                                          value
                                                        )
                                                      )
                                                    }
                                                    options={
                                                      getExpectedValueOptions(rule.depends_on_question_code ?? '').length > 0
                                                        ? getExpectedValueOptions(rule.depends_on_question_code ?? '')
                                                        : undefined
                                                    }
                                                  />
                                                </div>
                                              </div>
                                            </div>
                                          ))}

                                          {(option.visibility_rules ?? []).length === 0 && (
                                            <p className="rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                                              Aucune regle de visibilite pour cette option.
                                            </p>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  ))}

                                  {(selectedQuestion.options ?? []).length === 0 && (
                                    <p className="rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                                      Aucune option définie.
                                    </p>
                                  )}
                                </div>
                              </CollapsePanel>
                            )}

                            <CollapsePanel
                              title="Règles de visibilité"
                              subtitle="Choisissez une question précédente et une valeur attendue sans saisie manuelle fragile."
                              badge={`${(selectedQuestion.visibility_rules ?? []).length} règle(s)`}
                              action={
                                <button
                                  onClick={handleAddVisibilityRule}
                                  disabled={availableVisibilityQuestions.length === 0}
                                  className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                  Ajouter
                                </button>
                              }
                            >
                              <div className="space-y-3">
                                {(selectedQuestion.visibility_rules ?? []).map((rule, index) => (
                                  <div key={rule.id ?? index} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                                    <div className="mb-3 flex items-center justify-between gap-3">
                                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                        Regle {index + 1}
                                      </div>
                                      <button
                                        onClick={() => handleDeleteVisibilityRule(rule.id)}
                                        className="rounded-lg px-2 py-2 text-red-500 transition hover:bg-red-50"
                                      >
                                        <Trash2 className="h-4 w-4" />
                                      </button>
                                    </div>

                                    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
                                      <div className="min-w-0">
                                        <Field
                                          label="Question dépendante"
                                          value={rule.depends_on_question_code ?? ''}
                                          onChange={(value) =>
                                            updateQuestion(selectedStep.id, selectedQuestion.id, (question) => {
                                              const nextExpectedValue = getExpectedValueOptions(value)[0] ?? '';
                                              return updateVisibilityRuleInQuestion(
                                                updateVisibilityRuleInQuestion(
                                                  question,
                                                  index,
                                                  'depends_on_question_code',
                                                  value
                                                ),
                                                index,
                                                'expected_value',
                                                nextExpectedValue
                                              );
                                            })
                                          }
                                          options={availableVisibilityQuestions.map((question) => question.code)}
                                        />
                                        {rule.depends_on_question_code && (
                                          <p className="mt-2 rounded-xl bg-white px-3 py-2 text-xs leading-relaxed text-slate-500">
                                            {getRuleQuestionByCode(rule.depends_on_question_code)?.label ?? 'Question non trouvée'}
                                          </p>
                                        )}
                                      </div>
                                      <div className="min-w-0">
                                        <Field
                                          label="Opérateur"
                                          value={rule.operator}
                                          onChange={(value) =>
                                            updateQuestion(selectedStep.id, selectedQuestion.id, (question) =>
                                              updateVisibilityRuleInQuestion(
                                                question,
                                                index,
                                                'operator',
                                                value
                                              )
                                            )
                                          }
                                          options={['equals', 'not_equals']}
                                        />
                                      </div>
                                      <div className="min-w-0">
                                        <Field
                                          label="Valeur attendue"
                                          value={rule.expected_value}
                                          onChange={(value) =>
                                            updateQuestion(selectedStep.id, selectedQuestion.id, (question) =>
                                              updateVisibilityRuleInQuestion(
                                                question,
                                                index,
                                                'expected_value',
                                                value
                                              )
                                            )
                                          }
                                          options={
                                            getExpectedValueOptions(rule.depends_on_question_code ?? '').length > 0
                                              ? getExpectedValueOptions(rule.depends_on_question_code ?? '')
                                              : undefined
                                          }
                                        />
                                      </div>
                                    </div>
                                  </div>
                                ))}

                                {(selectedQuestion.visibility_rules ?? []).length === 0 && (
                                  <p className="rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                                    Aucune règle de visibilité.
                                  </p>
                                )}
                              </div>
                            </CollapsePanel>

                            <CollapsePanel
                              title="Contexte d'analyse"
                              subtitle="Associez une réponse à une phrase LLM et à un indice DFD uniquement si nécessaire."
                              badge={`${(selectedQuestion.answer_contexts ?? []).length} contexte(s)`}
                              action={
                                <button
                                  onClick={handleAddAnswerContext}
                                  className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                  Ajouter
                                </button>
                              }
                            >
                              <div className="space-y-3">
                                {(selectedQuestion.answer_contexts ?? []).map((context) => (
                                  <div key={context.id} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                                    <div className="mb-3 flex items-center justify-between gap-3">
                                      <div className="text-sm font-semibold text-slate-900">
                                        Reponse -&gt; contexte
                                      </div>
                                      <button
                                        onClick={() => handleDeleteAnswerContext(context.id)}
                                        className="rounded-lg px-2 py-2 text-red-500 transition hover:bg-red-50"
                                      >
                                        <Trash2 className="h-4 w-4" />
                                      </button>
                                    </div>

                                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                                      <div className="min-w-0">
                                        <Field
                                          label="Valeur reponse"
                                          value={context.option_value}
                                          onChange={(value) =>
                                            updateQuestion(selectedStep.id, selectedQuestion.id, (question) =>
                                              updateAnswerContextInQuestion(
                                                question,
                                                context.id,
                                                'option_value',
                                                value
                                              )
                                            )
                                          }
                                          options={
                                            selectedQuestionContextValues.length > 0
                                              ? selectedQuestionContextValues
                                              : undefined
                                          }
                                        />
                                      </div>
                                      <div className="min-w-0">
                                        <Field
                                          label="Categorie"
                                          value={context.context_category ?? ''}
                                          onChange={(value) =>
                                            updateQuestion(selectedStep.id, selectedQuestion.id, (question) =>
                                              updateAnswerContextInQuestion(
                                                question,
                                                context.id,
                                                'context_category',
                                                value
                                              )
                                            )
                                          }
                                        />
                                      </div>
                                    </div>

                                    <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
                                      <TextAreaField
                                        label="Phrase LLM"
                                        value={context.llm_sentence ?? ''}
                                        onChange={(value) =>
                                          updateQuestion(selectedStep.id, selectedQuestion.id, (question) =>
                                            updateAnswerContextInQuestion(
                                              question,
                                              context.id,
                                              'llm_sentence',
                                              value
                                            )
                                          )
                                        }
                                        rows={4}
                                      />
                                      <TextAreaField
                                        label="Indice DFD"
                                        value={context.diagram_hint ?? ''}
                                        onChange={(value) =>
                                          updateQuestion(selectedStep.id, selectedQuestion.id, (question) =>
                                            updateAnswerContextInQuestion(
                                              question,
                                              context.id,
                                              'diagram_hint',
                                              value
                                            )
                                          )
                                        }
                                        rows={4}
                                      />
                                    </div>
                                  </div>
                                ))}

                                {(selectedQuestion.answer_contexts ?? []).length === 0 && (
                                  <p className="rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                                    Aucun mapping de contexte defini pour cette question.
                                  </p>
                                )}
                              </div>
                            </CollapsePanel>
                          </div>
                        </CollapsePanel>
                      )}
                    </div>
                  </div>
                )}
              </section>
            </div>
          </>
        )}

        {activeSection === 'internal_solutions' && (
          <>
            <AdminHeader
              eyebrow="Contrôles de sécurité"
              title="Solutions internes"
              description="Gérez les solutions internes disponibles pour enrichir et contextualiser les mitigations avec les briques réellement utilisées."
            />

            <div className="mb-6 grid grid-cols-1 gap-5 md:grid-cols-3">
              <StatCard
                label="Solutions"
                value={String(internalSolutionStats.totalSolutions)}
                icon={<Settings2 />}
                tone="slate"
              />
              <StatCard
                label="Actives"
                value={String(internalSolutionStats.activeSolutions)}
                icon={<ShieldAlert />}
                tone="orange"
              />
              <StatCard
                label="Catégories"
                value={String(internalSolutionStats.uniqueCategories)}
                icon={<Database />}
                tone="emerald"
              />
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.9fr_1.1fr]">
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <h2 className="text-xl font-bold text-slate-900">
                      {internalSolutionForm.id_solution == null ? 'Nouvelle solution' : 'Modifier la solution'}
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                      Référencez les solutions internes réelles pour rendre les mitigations plus précises.
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  <Field
                    label="Nom de la solution"
                    value={internalSolutionForm.nom_solution}
                    onChange={(value) =>
                      setInternalSolutionForm((previous) => ({ ...previous, nom_solution: value }))
                    }
                  />
                  <Field
                    label="Type"
                    value={internalSolutionForm.type_solution}
                    onChange={(value) =>
                      setInternalSolutionForm((previous) => ({ ...previous, type_solution: value }))
                    }
                  />
                  <Field
                    label="Éditeur"
                    value={internalSolutionForm.editeur_solution}
                    onChange={(value) =>
                      setInternalSolutionForm((previous) => ({ ...previous, editeur_solution: value }))
                    }
                  />
                  <Field
                    label="Usage sécurité"
                    value={internalSolutionForm.usage_securite}
                    onChange={(value) =>
                      setInternalSolutionForm((previous) => ({ ...previous, usage_securite: value }))
                    }
                  />
                  <Field
                    label="Description"
                    value={internalSolutionForm.description_solution}
                    onChange={(value) =>
                      setInternalSolutionForm((previous) => ({ ...previous, description_solution: value }))
                    }
                  />

                  <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={internalSolutionForm.actif}
                      onChange={(event) =>
                        setInternalSolutionForm((previous) => ({ ...previous, actif: event.target.checked }))
                      }
                      className="h-4 w-4 rounded border-slate-300 text-orange-500 focus:ring-orange-400"
                    />
                    <span className="text-sm font-semibold text-slate-700">Solution active</span>
                  </label>
                </div>

                <div className="mt-5 flex flex-wrap gap-3">
                  <button
                    onClick={() => void handleSaveInternalSolution()}
                    className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-600"
                  >
                    <Save className="h-4 w-4" />
                    Enregistrer
                  </button>
                  <button
                    onClick={resetInternalSolutionForm}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                  >
                    Reinitialiser
                  </button>
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="mb-5 flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-bold text-slate-900">Référentiel des solutions internes</h2>
                    <p className="mt-1 text-sm text-slate-500">
                      Visualisez et pilotez les solutions utilisables dans les recommandations de mitigation.
                    </p>
                  </div>
                  <div className="rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">
                    {internalSolutionStats.totalSolutions} solution(s)
                  </div>
                </div>

                {internalSecuritySolutions.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
                    Aucune solution interne disponible pour le moment.
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-slate-200">
                    <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1fr)_auto_auto] gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <span>Solution</span>
                      <span>Type</span>
                      <span>Usage</span>
                      <span>Statut</span>
                      <span>Actions</span>
                    </div>
                    <div className="divide-y divide-slate-200">
                      {internalSecuritySolutions.map((solution) => (
                        <div
                          key={solution.id_solution}
                          className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,1fr)_auto_auto] gap-4 px-5 py-4 text-sm"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-slate-900">{solution.nom_solution}</p>
                            <p className="truncate text-xs text-slate-500">
                              {solution.editeur_solution || 'Éditeur non renseigné'}
                            </p>
                          </div>
                          <span className="truncate text-slate-700">{solution.type_solution}</span>
                          <span className="truncate text-slate-500">{solution.usage_securite || 'Usage non renseigné'}</span>
                          <div className="flex items-center justify-end">
                            <span
                              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                                solution.actif
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              {solution.actif ? 'Actif' : 'Inactif'}
                            </span>
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => handleEditInternalSolution(solution)}
                              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                            >
                              Modifier
                            </button>
                            <button
                              onClick={() => void handleDeleteInternalSolution(solution.id_solution)}
                              className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50"
                            >
                              Supprimer
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {activeSection === 'cve_graph' && (
          <>
              <AdminHeader
                eyebrow="Référentiel CVE"
                title="Explorateur des vulnérabilités"
                description="Visualisez un sous-graphe orienté sécurité et lancez des recherches simples pour relier technologies, produits, versions, CVE et vecteurs d’attaque."
              />

            <CveGraphExplorer
              graph={cveGraphResult}
              stats={cveGraphStats}
              isLoading={isLoadingCveGraph}
              searchQuery={cveGraphSearch}
              onSearchQueryChange={setCveGraphSearch}
              onSearch={() => {
                void runCveGraphSearch();
              }}
            />
          </>
        )}

        {activeSection === 'traceability' && (
          <div className="space-y-6">
            <AdminHeader
              eyebrow="Audit Trail"
              title="Traçabilité des actions"
              description="Consultez les actions importantes effectuées dans la plateforme avec l’acteur, la cible, la date et le détail des changements."
              action={
                <button
                  onClick={() => void refreshAuditTrailEntries()}
                  disabled={isLoadingAuditTrail}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw className={`h-4 w-4 ${isLoadingAuditTrail ? 'animate-spin' : ''}`} />
                  Actualiser
                </button>
              }
            />

            <div className="grid gap-4 md:grid-cols-3">
              <StatCard
                label="Événements"
                value={String(auditTrailEntries.length)}
                icon={<History />}
                tone="orange"
              />
              <StatCard
                label="Acteurs distincts"
                value={String(new Set(auditTrailEntries.map((item) => item.actor_username)).size)}
                icon={<ShieldAlert />}
                tone="slate"
              />
              <StatCard
                label="Actions distinctes"
                value={String(new Set(auditTrailEntries.map((item) => item.action_type)).size)}
                icon={<BookOpen />}
                tone="emerald"
              />
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="mb-5 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-bold text-slate-900">Journal des actions</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Créations, modifications, validations, suppressions et régénérations.
                  </p>
                </div>
              </div>

              {isLoadingAuditTrail ? (
                <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">
                  Chargement de la traçabilité...
                </div>
              ) : auditTrailEntries.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-500">
                  Aucun événement de traçabilité trouvé.
                </div>
              ) : (
                <div className="space-y-4">
                  {auditTrailEntries.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-2xl border border-slate-200 bg-slate-50/60 p-5"
                    >
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-slate-900 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
                              {formatAuditActionLabel(entry.action_type)}
                            </span>
                            <span className="rounded-full bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                              {entry.entity_type}
                            </span>
                          </div>
                          <p className="text-sm text-slate-700">
                            <span className="font-semibold text-slate-900">
                              {entry.actor_display_name || entry.actor_username}
                            </span>{' '}
                            a agi sur{' '}
                            <span className="font-semibold text-slate-900">
                              {entry.entity_label || `${entry.entity_type} #${entry.entity_id}`}
                            </span>
                          </p>
                          <p className="text-xs text-slate-500">
                            {formatAuditDate(entry.created_at)}
                            {entry.actor_email ? ` · ${entry.actor_email}` : ''}
                          </p>
                        </div>
                        <div className="text-xs font-medium text-slate-500">
                          ID #{entry.id}
                        </div>
                      </div>

                      {entry.comment && (
                        <p className="mt-3 rounded-xl bg-white px-3 py-2 text-sm text-slate-600">
                          {entry.comment}
                        </p>
                      )}

                      <div className="mt-4 grid gap-3 xl:grid-cols-3">
                        <div className="rounded-xl bg-white p-3">
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Avant
                          </p>
                          <p className="text-xs leading-relaxed text-slate-600">
                            {previewAuditPayload(entry.old_values) || 'Aucune donnée'}
                          </p>
                        </div>
                        <div className="rounded-xl bg-white p-3">
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Après
                          </p>
                          <p className="text-xs leading-relaxed text-slate-600">
                            {previewAuditPayload(entry.new_values) || 'Aucune donnée'}
                          </p>
                        </div>
                        <div className="rounded-xl bg-white p-3">
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Métadonnées
                          </p>
                          <p className="text-xs leading-relaxed text-slate-600">
                            {previewAuditPayload(entry.metadata) || 'Aucune donnée'}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeSection === 'references' && (
          <>
            <AdminHeader
              eyebrow="Référentiel documentaire"
              title="Gestion des références"
              description="Consultez les référentiels documentaires du catalogue, leur volumétrie et leur couverture sur les menaces."
            />

            <div className="grid grid-cols-1 gap-5 md:grid-cols-3 mb-6">
              <StatCard
                label="Références uniques"
                value={String(referenceStats.totalUniqueReferences)}
                icon={<LibraryBig />}
                tone="slate"
              />
              <StatCard
                label="Liaisons actives"
                value={String(catalogReferences.length)}
                icon={<Network />}
                tone="orange"
              />
              <StatCard
                label="Source dominante"
                value={String(referenceStats.topReference?.threatCount ?? 0)}
                icon={<Link2 />}
                tone="emerald"
              />
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[0.9fr_1.1fr]">
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <h2 className="text-xl font-bold text-slate-900">
                      {referenceForm.id_reference == null ? 'Nouvelle reference' : 'Modifier la reference'}
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                      Gere ici les references globales. Le catalogue menace ne fera ensuite que les selectionner.
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  <Field
                    label="Code reference"
                    value={referenceForm.reference_menace}
                    onChange={(value) =>
                      setReferenceForm((previous) => ({ ...previous, reference_menace: value }))
                    }
                  />
                  <Field
                    label="Nom de la source"
                    value={referenceForm.nom_reference}
                    onChange={(value) =>
                      setReferenceForm((previous) => ({ ...previous, nom_reference: value }))
                    }
                  />
                  <Field
                    label="Lien"
                    value={referenceForm.lien}
                    onChange={(value) =>
                      setReferenceForm((previous) => ({ ...previous, lien: value }))
                    }
                  />
                </div>

                <div className="mt-5 flex flex-wrap gap-3">
                  <button
                    onClick={() => void handleSaveReferenceRecord()}
                    className="inline-flex items-center gap-2 rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-600"
                  >
                    <Save className="h-4 w-4" />
                    Enregistrer
                  </button>
                  <button
                    onClick={resetReferenceForm}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                  >
                    Reinitialiser
                  </button>
                </div>
              </div>

              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="mb-5 flex items-center justify-between gap-4">
                  <div>
                  <h2 className="text-xl font-bold text-slate-900">Référentiels du catalogue</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Affichage minimaliste par nom de source et nombre de codes.
                  </p>
                </div>
                  <div className="rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">
                    {referenceStats.totalUniqueReferences} famille(s)
                  </div>
                </div>

                {catalogReferenceGroups.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
                    Aucune reference disponible pour le moment.
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-slate-200">
                    <div className="grid grid-cols-[minmax(0,2fr)_auto] gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      <span>Nom reference</span>
                      <span>Nombre</span>
                    </div>
                    <div className="divide-y divide-slate-200">
                      {catalogReferenceGroups.map((group) => (
                        <div
                          key={group.normalized_name}
                          className="grid grid-cols-[minmax(0,2fr)_auto] gap-4 px-5 py-4 text-sm"
                        >
                          <p className="truncate font-semibold text-slate-900">{group.display_name}</p>
                          <div className="flex items-center justify-end">
                            <span className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white">
                              {group.code_count}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="mb-5">
                <h2 className="text-xl font-bold text-slate-900">Codes de reference detailles</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Edition ligne par ligne des codes de reference disponibles pour le catalogue.
                </p>
              </div>

              <div className="overflow-hidden rounded-2xl border border-slate-200">
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.6fr)_auto] gap-4 border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <span>Code</span>
                  <span>Source</span>
                  <span>Lien</span>
                  <span>Actions</span>
                </div>
                <div className="divide-y divide-slate-200">
                  {catalogReferences.map((reference) => (
                    <div
                      key={reference.id_reference}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.6fr)_auto] gap-4 px-5 py-4 text-sm"
                    >
                      <span className="truncate font-semibold text-slate-900">{reference.reference_menace}</span>
                      <span className="truncate text-slate-700">{reference.nom_reference}</span>
                      <span className="truncate text-slate-500">{reference.lien || 'Lien non renseigne'}</span>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleEditReferenceRecord(reference)}
                          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                        >
                          Modifier
                        </button>
                        <button
                          onClick={() => void handleDeleteReferenceRecord(reference.id_reference)}
                          className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50"
                        >
                          Supprimer
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function AdminHeader({
  eyebrow,
  title,
  description,
  action,
}: Readonly<{
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}>) {
  return (
    <div className="mb-10">
      <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 shadow-sm">
          <ShieldAlert className="h-4 w-4 text-orange-500" />
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            {eyebrow}
          </span>
        </div>
        {action}
      </div>

      <h1 className="mb-3 text-4xl font-bold tracking-tight text-slate-900 md:text-5xl">
        {title}
      </h1>

      <p className="max-w-3xl text-base leading-relaxed text-slate-500 md:text-lg">
        {description}
      </p>
    </div>
  );
}

function CollapsePanel({
  title,
  subtitle,
  badge,
  action,
  children,
  defaultOpen = false,
}: Readonly<{
  title: string;
  subtitle?: string;
  badge?: string;
  action?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}>) {
  return (
    <details
      open={defaultOpen}
      className="group overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h4 className="text-base font-semibold text-slate-900">{title}</h4>
            {badge && (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                {badge}
              </span>
            )}
          </div>
          {subtitle && <p className="mt-1 pr-4 text-sm leading-relaxed text-slate-500">{subtitle}</p>}
        </div>

        <div className="flex items-center gap-3">
          {action && <div onClick={(event) => event.stopPropagation()}>{action}</div>}
          <div className="rounded-full border border-slate-200 p-2 text-slate-500 transition group-open:rotate-180">
            <ChevronDown className="h-4 w-4" />
          </div>
        </div>
      </summary>

      <div className="border-t border-slate-100 px-5 py-4">{children}</div>
    </details>
  );
}

function StatCard({
  label,
  value,
  icon,
  tone,
}: Readonly<{
  label: string;
  value: string;
  icon: ReactNode;
  tone: 'orange' | 'slate' | 'emerald';
}>) {
  const tones = {
    orange: 'bg-orange-100 text-orange-700',
    slate: 'bg-slate-900 text-white',
    emerald: 'bg-emerald-100 text-emerald-700',
  };

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-xl">
      <div className="mb-6 flex items-center justify-between">
        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${tones[tone]}`}>
          {icon}
        </div>
      </div>

      <p className="mb-1 text-sm font-medium text-slate-500">{label}</p>
      <p className="text-4xl font-bold text-slate-900">{value}</p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  options,
  disabled,
}: Readonly<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  options?: string[];
  disabled?: boolean;
}>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {options ? (
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-orange-400 focus:outline-none disabled:bg-slate-50"
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-orange-400 focus:outline-none disabled:bg-slate-50"
        />
      )}
    </label>
  );
}

function OrderField({
  label,
  value,
  onCommit,
  disabled,
}: Readonly<{
  label: string;
  value: number;
  onCommit: (value: number) => void;
  disabled?: boolean;
}>) {
  const [draftValue, setDraftValue] = useState(String(value));

  useEffect(() => {
    setDraftValue(String(value));
  }, [value]);

  const commitValue = () => {
    const normalized = Number.parseInt(draftValue.trim() || '0', 10) || 1;
    onCommit(normalized);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitValue();
    }
  };

  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <input
        type="number"
        min={1}
        inputMode="numeric"
        value={draftValue}
        onChange={(event) => setDraftValue(event.target.value)}
        onBlur={commitValue}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-orange-400 focus:outline-none disabled:bg-slate-50"
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  rows = 4,
}: Readonly<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-orange-400 focus:outline-none"
      />
    </label>
  );
}

function MetricPill({
  label,
  value,
}: Readonly<{
  label: string;
  value: string;
}>) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-slate-900">{value}</p>
    </div>
  );
}
