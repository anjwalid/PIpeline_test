export type Severity = 'CRITIQUE' | 'ÉLEVÉ' | 'MOYEN' | 'FAIBLE';

export interface AnalysisSubmitPayload {
  app_name: string;
  app_description: string;
  questionnaire_code: string;
  answers: AnswersMap;
  dev_name?: string;
}

export interface SecOpsChatStepContext {
  title: string;
  questions: { code: string; label: string }[];
}

export interface SecOpsChatDraftContext {
  app_name?: string;
  app_description?: string;
  dev_name?: string;
  questionnaire_code?: string;
  answers?: AnswersMap;
  active_question?: SecOpsChatQuestionContext;
  questionnaire_steps?: SecOpsChatStepContext[];
}

export interface SecOpsChatQuestionOptionContext {
  label: string;
  value: string;
}

export interface SecOpsChatQuestionContext {
  code: string;
  number?: string;
  label: string;
  help_text?: string | null;
  aide?: string | null;
  question_type: QuestionType;
  is_required: boolean;
  visible_options?: SecOpsChatQuestionOptionContext[];
}

export interface SecOpsChatActionOption {
  action_id: string;
  label: string;
  payload: Record<string, unknown>;
}

export interface SecOpsChatActionGroup {
  title: string;
  options: SecOpsChatActionOption[];
}


export type QuestionType =
  | 'boolean'
  | 'select'
  | 'text'
  | 'textarea'
  | 'multiselect';

export type AnswerValue = string | boolean | string[] | null;
export type AnswersMap = Record<string, AnswerValue>;

export interface BaseInfo {
  app_name: string;
  app_description: string;
  dev_name?: string;
}

export interface QuestionnaireStep {
  id: number;
  questionnaire_id?: number;
  code: string;
  title: string;
  step_order: number;
  questions?: Question[];
}

export interface QuestionOption {
  id: number;
  question_id: number;
  label: string;
  value: string;
  display_order: number;
  visibility_rules?: QuestionOptionVisibilityRule[];
}

export interface QuestionOptionVisibilityRule {
  id: number;
  question_option_id: number;
  depends_on_question_id: number;
  operator: 'equals' | 'not_equals';
  expected_value: string;
  option_value?: string;
  depends_on_question_code?: string;
}

export interface QuestionVisibilityRule {
  id: number;
  question_id: number;
  depends_on_question_id: number;
  operator: 'equals' | 'not_equals';
  expected_value: string;
  question_code?: string;
  depends_on_question_code?: string;
}

export interface QuestionAnswerContext {
  id: number;
  questionnaire_code: string;
  question_code: string;
  option_value: string;
  context_category?: string | null;
  llm_sentence?: string | null;
  diagram_hint?: string | null;
}

export interface Question {
  id: number;
  step_id: number;
  step_code?: string;
  code: string;
  label: string;
  help_text?: string | null;
  aide?: string | null;
  question_type: QuestionType;
  is_required: boolean;
  display_order: number;
  default_value?: string | null;
  is_active: boolean;
  backend_key: string;
  send_if_true_only: boolean;
  options?: QuestionOption[];
  visibility_rules?: QuestionVisibilityRule[];
  answer_contexts?: QuestionAnswerContext[];
}

export interface Questionnaire {
  id: number;
  code: string;
  name: string;
  version: number;
  status: string;
  is_active: boolean;
  steps: QuestionnaireStep[];
  questions: Question[];
}

export interface QuestionnaireListItem {
  id: number;
  code: string;
  name: string;
  version: number;
  status: string;
  is_active: boolean;
}

export interface QuestionnaireOptionInput {
  label: string;
  value: string;
  display_order: number;
  visibility_rules: QuestionnaireOptionVisibilityRuleInput[];
}

export interface QuestionnaireOptionVisibilityRuleInput {
  option_value: string;
  depends_on_question_code: string;
  operator: 'equals' | 'not_equals';
  expected_value: string;
}

export interface QuestionnaireVisibilityRuleInput {
  question_code: string;
  depends_on_question_code: string;
  operator: 'equals' | 'not_equals';
  expected_value: string;
}

export interface QuestionnaireAnswerContextInput {
  option_value: string;
  context_category?: string | null;
  llm_sentence?: string | null;
  diagram_hint?: string | null;
}

export interface QuestionnaireQuestionInput {
  code: string;
  label: string;
  help_text?: string | null;
  aide?: string | null;
  question_type: QuestionType;
  is_required: boolean;
  display_order: number;
  default_value?: string | null;
  is_active: boolean;
  backend_key?: string | null;
  send_if_true_only: boolean;
  options: QuestionnaireOptionInput[];
  visibility_rules: QuestionnaireVisibilityRuleInput[];
  answer_contexts: QuestionnaireAnswerContextInput[];
}

export interface QuestionnaireStepInput {
  code: string;
  title: string;
  step_order: number;
  questions: QuestionnaireQuestionInput[];
}

export interface QuestionnaireUpsertPayload {
  code: string;
  name: string;
  version: number;
  status: string;
  is_active: boolean;
  steps: QuestionnaireStepInput[];
}

export interface CatalogMitigation {
  id_mitigation: number;
  id_menace: number;
  description_mitigation: string;
}

export interface CatalogScenario {
  id_scenario: number;
  id_menace: number;
  description_scenario: string;
}

export interface CatalogReference {
  id_reference: number;
  reference_menace: string;
  nom_reference: string;
  lien?: string | null;
  lien_specifique?: string | null;
}

export interface CatalogReferenceGroup {
  normalized_name: string;
  display_name: string;
  code_count: number;
  threat_count: number;
  reference_codes: string[];
}

export interface InternalSecuritySolution {
  id_solution: number;
  nom_solution: string;
  type_solution: string;
  editeur_solution?: string | null;
  usage_securite?: string | null;
  description_solution?: string | null;
  actif: boolean;
}

export interface CatalogThreat {
  id_menace: number;
  nom_menace: string;
  description?: string | null;
  reference_menace?: string | null;
  mitigations: CatalogMitigation[];
  scenarios: CatalogScenario[];
  references: CatalogReference[];
}

export interface CatalogThreatListItem {
  id_menace: number;
  nom_menace: string;
  description?: string | null;
  reference_menace?: string | null;
  mitigation_count: number;
  scenario_count: number;
  reference_count: number;
}

export interface CatalogMitigationInput {
  description_mitigation: string;
}

export interface CatalogScenarioInput {
  description_scenario: string;
}

export interface CatalogReferenceInput {
  id_reference?: number | null;
  reference_menace: string;
  nom_reference: string;
  lien?: string | null;
}

export interface RegulatoryDocument {
  id: number;
  display_name: string;
  category: string;
  original_filename: string;
  file_size: number | null;
  chunk_count: number;
  status: 'indexing' | 'indexed' | 'error';
  error_message: string | null;
  uploaded_at: string;
  indexed_at: string | null;
  uploaded_by: string | null;
  shortcuts: string[];
}

export interface ThreatFrameworkMapping {
  id_menace: number;
  nom_menace?: string | null;
  cwe?: string | null;
  cwe_lien?: string | null;
  mitre_atlas?: string | null;
  mitre_atlas_lien?: string | null;
  mitre_attack?: string | null;
  mitre_attack_lien?: string | null;
  mitre_ics?: string | null;
  mitre_ics_lien?: string | null;
  mitre_cloud?: string | null;
  mitre_cloud_lien?: string | null;
  capec?: string | null;
  capec_lien?: string | null;
  owasp?: string | null;
  owasp_lien?: string | null;
  emb3d?: string | null;
  emb3d_lien?: string | null;
  nist_ref?: string | null;
  iso27001?: string | null;
  pci_dss?: string | null;
  ccm_ref?: string | null;
}

export interface CatalogThreatUpsertPayload {
  nom_menace: string;
  description?: string | null;
  reference_menace?: string | null;
  mitigations: CatalogMitigationInput[];
  scenarios: CatalogScenarioInput[];
  references: CatalogReferenceInput[];
}

export interface AnalysisSubmitPayload {
  app_name: string;
  app_description: string;
  questionnaire_code: string;
  answers: AnswersMap;
  dev_name?: string;
}

export interface AnalysisHistoryItem {
  id: string;
  appName: string;
  developerName: string;
  createdAt: string;
  summary: string;
  reportUrl: string;
  status?: ReportStatus;
}

export interface Threat {
  id: string;
  name: string;
  severity: Severity;
  justification: string;
  attacks: string[];
  impacts: string[];
  controls: string[];
}

export interface AnalysisResult {
  context_summary: string;
  attack_surfaces: string[];
  risk_score: number;
  threats: Threat[];
}

export interface SecOpsReport {
  id: string;
  appName: string;
  analystName: string;
  submittedAt: string;
  status: ReportStatus;
  reportUrl: string;
  summary: string;
  validatedBy?: string;
  validatedAt?: string;
  managerComment?: string;
  annotations?: string[];
}

export type ReportStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED';

export interface ManagerReviewFeedbackItem {
  decision_type: 'REJECTED' | 'APPROVED' | 'PENDING';
  reason_code: string;
  severity?: string | null;
  section_type?: string;
  section_identifier?: string | null;
  comment?: string | null;
}

export interface ManagerReviewFeedbackEntry extends ManagerReviewFeedbackItem {
  id: number;
  created_by?: string | null;
  created_by_username?: string | null;
  created_by_email?: string | null;
  created_at: string;
}

export interface SecOpsModificationReason {
  reason_code: string;
  section_type?: string;
  section_identifier?: string | null;
  comment?: string | null;
}

export interface ReportAnnotation {
  id: string;
  annotation: string;
  created_by_username?: string | null;
  created_by_email?: string | null;
  created_at: string;
}

export interface ReportStatusHistoryEntry {
  id: string;
  old_status?: string | null;
  new_status: ReportStatus;
  changed_by_username?: string | null;
  changed_by_email?: string | null;
  comment?: string | null;
  changed_at: string;
}

export interface ReportRecord {
  id: string;
  title: string;
  app_name: string;
  description?: string | null;
  summary: string;
  file_name: string;
  file_type: string;
  file_size?: number | null;
  status: ReportStatus;
  report_url: string;
  generated_by: string;
  generated_by_username?: string | null;
  generated_by_email?: string | null;
  generated_at: string;
  validated_by?: string | null;
  validated_by_username?: string | null;
  validated_by_email?: string | null;
  validated_at?: string | null;
  annotations: ReportAnnotation[];
  status_history: ReportStatusHistoryEntry[];
  manager_feedback: ManagerReviewFeedbackEntry[];
}

export interface EditableThreat {
  name: string;
  description?: string | null;
  attack_scenarios: string[];
  mitigations: string[];
  references?: CatalogReference[];
}

export interface DfdLayout {
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotate?: number;
  curve?: number;
  strokeWidth?: number;
  dashLength?: number;
  dashGap?: number;
}

export interface DfdBoundaryFile {
  name: string;
  layout?: DfdLayout;
}

export interface DfdNodeFile {
  name: string;
  boundary: string;
  layout?: DfdLayout;
}

export interface DfdFlowFile {
  source: string;
  target: string;
  label: string;
  source_handle?: string;
  target_handle?: string;
}

export interface StructuredDfd {
  boundaries: DfdBoundaryFile[];
  external_entities: DfdNodeFile[];
  processes: DfdNodeFile[];
  data_stores: DfdNodeFile[];
  data_flows: DfdFlowFile[];
}

export interface ReportResultVersionRecord {
  version_number: number;
  version_label: string;
  app_name: string;
  developer_name: string;
  application_description: string;
  selected_threats: EditableThreat[];
  dfd_json: StructuredDfd;
  dfd_image_path?: string | null;
  dfd_reference?: string | null;
  download_url?: string | null;
  created_by_username?: string | null;
  created_by_email?: string | null;
  change_reason?: string | null;
  created_at: string;
}

export interface ReportResultsPayload {
  app_name: string;
  developer_name: string;
  application_description: string;
  selected_threats: EditableThreat[];
  application_version?: string;
  dfd_json: StructuredDfd;
  dfd_image_path?: string | null;
  dfd_reference?: string | null;
  modification_reasons?: SecOpsModificationReason[];
  modification_comment?: string | null;
}

export interface ReportResultsRecord extends ReportResultsPayload {
  report_id: string;
  version_number: number;
  updated_at?: string | null;
  version_history: ReportResultVersionRecord[];
}

export interface ReportsByMonthEntry {
  month: string;
  count: number;
}

export interface ThreatFrequencyEntry {
  threat_name: string;
  count: number;
}

export interface RiskyApplicationEntry {
  report_id: string;
  app_name: string;
  status: ReportStatus;
  threat_count: number;
  scenario_count: number;
  mitigation_count: number;
  risk_score: number;
  generated_at: string;
}

export interface ManagerDashboardMetrics {
  total_reports: number;
  approved_reports: number;
  approval_rate: number;
  global_approved_reports: number;
  global_approval_rate: number;
  my_approved_reports: number;
  my_approval_rate: number;
  average_validation_time_hours?: number | null;
  reports_by_month: ReportsByMonthEntry[];
  most_frequent_threats: ThreatFrequencyEntry[];
  riskiest_applications: RiskyApplicationEntry[];
}

export interface AuditTrailEntry {
  id: number;
  actor_id?: string | null;
  actor_username: string;
  actor_email?: string | null;
  actor_display_name?: string | null;
  actor_role?: string | null;
  action_type: string;
  entity_type: string;
  entity_id: string;
  entity_label?: string | null;
  parent_entity_type?: string | null;
  parent_entity_id?: string | null;
  old_values?: Record<string, unknown> | null;
  new_values?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  comment?: string | null;
  created_at: string;
}

export interface CveGraphMatch {
  cve_id: string;
  description: string;
  vendor?: string | null;
  product?: string | null;
  product_version?: string | null;
  attack_vectors: string[];
  severity?: string | null;
  base_score?: number | null;
  published?: string | null;
}

export interface CveGraphNode {
  id: string;
  label: string;
  node_type: 'Vendor' | 'Product' | 'ProductVersion' | 'CVE' | 'AttackVector' | string;
  name: string;
  score?: number | null;
  metadata: Record<string, unknown>;
}

export interface CveGraphEdge {
  source: string;
  target: string;
  label: string;
}

export interface CveGraphSearchResponse {
  enabled: boolean;
  disabled_reason?: string | null;
  query: string;
  extracted_terms: string[];
  nodes: CveGraphNode[];
  edges: CveGraphEdge[];
  matches: CveGraphMatch[];
}

export interface CveGraphStats {
  enabled: boolean;
  disabled_reason?: string | null;
  vendor_count: number;
  product_count: number;
  version_count: number;
  cve_count: number;
  attack_vector_count: number;
  critical_cve_count: number;
  latest_cves: CveGraphMatch[];
}
