import { buildAuthenticatedHeaders } from '../auth/apiAuth';
import { API_BASE_URL } from '../config';
import type { SecOpsChatActionGroup, SecOpsChatDraftContext } from '../types';
import { showErrorAlert } from '../utils/alerts';

export interface SecOpsChatReply {
  reply: string;
  option_groups: SecOpsChatActionGroup[];
}

export interface SecOpsChatRequestPayload {
  message: string;
  report_id?: string;
  draft_context?: SecOpsChatDraftContext;
  chat_mode?: 'guided' | 'normal';
  action_id?: string;
  action_payload?: Record<string, unknown>;
}

interface ApiErrorDetail {
  error_type?: string;
  message?: string;
  blocked_entity?: string;
  guardrail_name?: string;
}

export class SecOpsChatGuardrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecOpsChatGuardrailError';
  }
}

export class SecOpsChatPopupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecOpsChatPopupError';
  }
}

function normalizeDetectorLabel(detectorType: string): string {
  const normalized = detectorType.trim().toLowerCase();
  if (normalized === 'prompt_attack') {
    return 'tentative de prompt injection';
  }
  if (normalized === 'unknown_links') {
    return 'lien non approuve';
  }
  if (normalized.startsWith('pii/')) {
    const piiType = normalized.slice(4);
    const piiLabels: Record<string, string> = {
      email: 'adresse email',
      name: 'nom de personne',
      phone_number: 'numero de telephone',
      address: 'adresse postale',
      credit_card: 'carte bancaire',
      iban_code: 'IBAN',
      ip_address: 'adresse IP',
      us_social_security_number: 'numero de securite sociale',
    };
    return piiLabels[piiType] || `donnee sensible (${piiType})`;
  }
  if (normalized.startsWith('moderated_content/')) {
    const contentType = normalized.slice('moderated_content/'.length);
    const contentLabels: Record<string, string> = {
      crime: 'contenu lie a une activite illegale',
      hate: 'contenu haineux',
      profanity: 'contenu injurieux',
      self_harm: 'contenu d automutilation',
      sexual: 'contenu sexuel',
      violence: 'contenu violent',
      weapons: 'contenu lie aux armes',
    };
    return contentLabels[contentType] || `contenu modere (${contentType})`;
  }
  return detectorType;
}

function buildNormalizedBadRequestMessage(rawMessage: string): string {
  const promptAttackDetected = rawMessage.includes('"detector_type": "prompt_attack", "detected": true')
    || rawMessage.includes("'detector_type': 'prompt_attack', 'detected': True");
  const piiEmailDetected = rawMessage.includes('"detector_type": "pii/email", "detected": true')
    || rawMessage.includes("'detector_type': 'pii/email', 'detected': True");

  const detectedTypes: string[] = [];
  const regex = /['"]detector_type['"]:\s*['"]([^'"]+)['"][^]*?['"]detected['"]:\s*(true|false|True|False)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rawMessage)) !== null) {
    const detectorType = match[1];
    const detectedValue = match[2].toLowerCase() === 'true';
    if (detectedValue) {
      const label = normalizeDetectorLabel(detectorType);
      if (!detectedTypes.includes(label)) {
        detectedTypes.push(label);
      }
    }
  }

  if (promptAttackDetected) {
    return [
      'Votre message a ete bloque par la protection conversationnelle AWB.',
      'Une tentative de prompt injection ou de contournement des instructions a ete detectee.',
      'Veuillez reformuler votre demande de maniere neutre puis reessayer.',
    ].join(' ');
  }

  if (piiEmailDetected) {
    return [
      'Votre message a ete bloque par la protection des donnees AWB.',
      'Une adresse email a ete detectee dans la requete.',
      'Veuillez supprimer ou masquer cette information avant de reessayer.',
    ].join(' ');
  }

  if (detectedTypes.length > 0) {
    return [
      'Votre message a ete bloque par une politique de securite AWB.',
      `Element detecte : ${detectedTypes.join(', ')}.`,
      'Veuillez modifier votre message puis reessayer.',
    ].join(' ');
  }

  if (
    rawMessage.includes('Violated guardrail policy') ||
    rawMessage.includes('lakera_guardrail_response')
  ) {
    return [
      'Votre message a ete bloque par une politique de securite AWB avant envoi au modele.',
      'Veuillez reformuler la demande ou retirer le contenu sensible puis reessayer.',
    ].join(' ');
  }

  return rawMessage;
}

export async function sendSecOpsChatMessage(
  payload: SecOpsChatRequestPayload
): Promise<SecOpsChatReply> {
  const response = await fetch(`${API_BASE_URL}/secops-chat/message`, {
    method: 'POST',
    headers: await buildAuthenticatedHeaders({ contentType: 'application/json' }),
    body: JSON.stringify(payload),
  });

  const data = (await response.json()) as SecOpsChatReply | { detail?: string | ApiErrorDetail };

  if (!response.ok) {
    const detail =
      typeof data === 'object' && data !== null && 'detail' in data
        ? data.detail
        : null;
    if (
      response.status === 403 &&
      detail &&
      typeof detail === 'object' &&
      detail.error_type === 'GUARDRAIL_BLOCKED'
    ) {
      const message =
        String(detail.message || '').trim() ||
        "Cette demande contrevient a la strategie de protection AWB. Retirez les donnees sensibles ou les liens non autorises.";
      await showErrorAlert('Action non autorisee', message);
      throw new SecOpsChatGuardrailError(message);
    }
    if (
      response.status === 400 &&
      detail &&
      typeof detail === 'object' &&
      detail.error_type === 'LITELLM_BAD_REQUEST'
    ) {
      const rawMessage =
        String(detail.message || '').trim() ||
        `Erreur API: ${response.status} ${response.statusText}`;
      const message = buildNormalizedBadRequestMessage(rawMessage);
      await showErrorAlert('Requete bloquee par la protection AWB', message);
      throw new SecOpsChatPopupError(message);
    }
    const fallbackMessage =
      typeof detail === 'string'
        ? detail
        : typeof detail === 'object' && detail !== null
          ? String(detail.message || '').trim()
          : '';
    throw new Error(fallbackMessage || `Erreur API: ${response.status} ${response.statusText}`);
  }

  return data as SecOpsChatReply;
}
