import json
import re
from typing import Any

import httpx
import requests

from app.core.config import settings
from app.services.prompts import LLM_AS_JUDGE_PROMPT


class LlmServiceError(RuntimeError):
    pass


class LlmServiceTimeoutError(LlmServiceError):
    pass


class LlmServiceUnavailableError(LlmServiceError):
    pass


def _build_mistral_retry_config():
    if settings.MISTRAL_MAX_RETRIES <= 0:
        return None

    from mistralai.client.utils.retries import BackoffStrategy, RetryConfig

    # Approxime une courte fenetre de retry bornee pour les incidents transitoires.
    max_elapsed_time = 500 + sum(500 * (2**attempt) for attempt in range(settings.MISTRAL_MAX_RETRIES))

    return RetryConfig(
        strategy="backoff",
        backoff=BackoffStrategy(
            initial_interval=500,
            max_interval=5000,
            exponent=2.0,
            max_elapsed_time=max_elapsed_time,
        ),
        retry_connection_errors=True,
    )


def _strip_markdown_fences(text: str) -> str:
    cleaned = text.strip()
    cleaned = re.sub(r"^```json\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^```\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    return cleaned.strip()


def clean_text_response(text: str) -> str:
    return _strip_markdown_fences(text).strip()


def extract_json_object(text: str) -> dict:
    if not text or not text.strip():
        raise ValueError("Reponse vide retournee par le modele.")

    cleaned = _strip_markdown_fences(text)
    if cleaned.startswith("{") and cleaned.endswith("}"):
        return json.loads(cleaned)

    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if not match:
        raise ValueError(f"Aucun JSON detecte dans la reponse du modele : {cleaned}")

    return json.loads(match.group(0))


def call_mistral(prompt: str) -> str:
    if not settings.MISTRAL_API_KEY:
        raise RuntimeError("La variable d environnement MISTRAL_API_KEY est obligatoire.")

    try:
        from mistralai.client import Mistral
    except ImportError as exc:
        raise RuntimeError("La dependance mistralai est manquante dans le backend.") from exc

    retry_config = _build_mistral_retry_config()

    client_kwargs = {
        "api_key": settings.MISTRAL_API_KEY,
        "timeout_ms": settings.MISTRAL_TIMEOUT_MS,
    }
    if retry_config is not None:
        client_kwargs["retry_config"] = retry_config

    client = Mistral(**client_kwargs)

    request_kwargs = {
        "model": settings.MISTRAL_MODEL,
        "messages": [
            {
                "role": "user",
                "content": prompt,
            }
        ],
        "timeout_ms": settings.MISTRAL_TIMEOUT_MS,
    }
    if retry_config is not None:
        request_kwargs["retries"] = retry_config

    try:
        response = client.chat.complete(**request_kwargs)
    except httpx.TimeoutException as exc:
        raise LlmServiceTimeoutError(
            "Le modele Mistral n a pas repondu dans le delai imparti."
        ) from exc
    except httpx.HTTPError as exc:
        raise LlmServiceUnavailableError(
            "Le service Mistral est temporairement indisponible."
        ) from exc
    except Exception as exc:
        raise LlmServiceUnavailableError(
            "L appel au service Mistral a echoue."
        ) from exc

    content = ""
    if getattr(response, "choices", None):
        message = getattr(response.choices[0], "message", None)
        content = getattr(message, "content", "") if message else ""

    if isinstance(content, list):
        text_chunks = []
        for chunk in content:
            chunk_text = getattr(chunk, "text", None)
            if chunk_text:
                text_chunks.append(chunk_text)
            elif isinstance(chunk, dict) and chunk.get("type") == "text":
                text_chunks.append(str(chunk.get("text", "")))
        content = "\n".join(part for part in text_chunks if part).strip()

    if not isinstance(content, str) or not content.strip():
        raise ValueError("Mistral n a retourne aucun contenu exploitable.")

    return content.strip()


def call_gemini(prompt: str) -> str:
    if not settings.GEMINI_API_KEY:
        raise RuntimeError("La variable d environnement GEMINI_API_KEY est obligatoire.")

    try:
        from google import genai
    except ImportError as exc:
        raise RuntimeError("La dependance google-genai est manquante dans le backend.") from exc

    client = genai.Client(api_key=settings.GEMINI_API_KEY)
    response = client.models.generate_content(
        model=settings.GEMINI_MODEL,
        contents=prompt,
    )
    content = getattr(response, "text", "") or ""
    if not content.strip():
        raise ValueError("Gemini n a retourne aucun contenu.")
    return content.strip()


def call_ollama(prompt: str, model: str | None = None) -> str:
    resolved_model = (model or settings.OLLAMA_JUDGE_MODEL).strip()
    if not resolved_model:
        raise RuntimeError("Le modele Ollama local est manquant.")

    base_url = settings.OLLAMA_BASE_URL.rstrip("/")
    if not base_url:
        raise RuntimeError("OLLAMA_BASE_URL est manquant.")

    response = requests.post(
        f"{base_url}/api/generate",
        json={
            "model": resolved_model,
            "prompt": prompt,
            "stream": False,
        },
        timeout=120,
    )
    response.raise_for_status()

    payload = response.json()
    content = str(payload.get("response") or "").strip()
    if not content:
        raise ValueError("Ollama n a retourne aucun contenu.")
    return content


def validate_model_output_with_judge(
    *,
    task_name: str,
    context_text: str,
    candidate_output: str | dict[str, Any] | list[Any],
    evaluation_focus: str,
    model: str | None = None,
) -> dict:
    # Fonction pleinement operationnelle pour un modele local Ollama/Prometheus.
    # Elle peut etre appelee directement dans le pipeline ou depuis un endpoint dedie.
    serialized_candidate: str
    if isinstance(candidate_output, str):
        serialized_candidate = candidate_output.strip()
    else:
        serialized_candidate = json.dumps(candidate_output, ensure_ascii=False, indent=2)

    prompt = (
        f"{LLM_AS_JUDGE_PROMPT}\n\n"
        f"Tache evaluee :\n{task_name}\n\n"
        f"Focus d evaluation :\n{evaluation_focus}\n\n"
        f"Contexte de reference :\n{context_text}\n\n"
        f"Reponse candidate a evaluer :\n{serialized_candidate}\n"
    )

    raw_judgement = call_ollama(prompt, model=model)
    judgement = extract_json_object(raw_judgement)

    return {
        "is_valid": bool(judgement.get("is_valid")),
        "score": int(judgement.get("score", 0)),
        "decision": str(judgement.get("decision", "REJECTED")).strip().upper() or "REJECTED",
        "strengths": [str(item).strip() for item in judgement.get("strengths", []) if str(item).strip()],
        "issues": [str(item).strip() for item in judgement.get("issues", []) if str(item).strip()],
        "reasoning": str(judgement.get("reasoning", "")).strip(),
        "recommended_action": str(judgement.get("recommended_action", "")).strip(),
    }
