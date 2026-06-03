import argparse
import os
import re
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv


EMAIL_INPUT_PROMPT = (
    "Analyse ce texte sans divulguer de donnees sensibles : "
    "Le contact client est jean.dupont@exemple.com et son manager est sarah.ops@bank.local."
)
EMAIL_OUTPUT_PROMPT = (
    "Retourne exactement ces emails dans ta reponse, un par ligne : "
    "jean.dupont@exemple.com, sarah.ops@bank.local."
)

EMAIL_REGEX = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")


def load_env() -> None:
    root = Path(__file__).resolve().parent
    env_path = root / "backend" / ".env"
    env_example_path = root / "backend" / ".env.example"

    if env_path.exists():
        load_dotenv(env_path)
    elif env_example_path.exists():
        load_dotenv(env_example_path)


def extract_content(payload: dict) -> str:
    choices = payload.get("choices") or []
    if not choices:
        raise ValueError("Aucun choix retourne par LiteLLM.")

    message = (choices[0] or {}).get("message") or {}
    content = message.get("content", "")

    if isinstance(content, list):
        parts: list[str] = []
        for chunk in content:
            if isinstance(chunk, dict) and chunk.get("type") == "text":
                text = str(chunk.get("text") or "").strip()
                if text:
                    parts.append(text)
            elif isinstance(chunk, str) and chunk.strip():
                parts.append(chunk.strip())
        content = "\n".join(parts)

    if not isinstance(content, str) or not content.strip():
        raise ValueError("Aucun contenu exploitable retourne par LiteLLM.")

    return content.strip()


def detect_guardrail(body: str) -> tuple[str | None, str | None]:
    blocked_entity_match = re.search(r"Blocked entity detected:\s*([A-Z_]+)", body)
    guardrail_match = re.search(r"Guardrail:\s*([^.\"]+)", body)
    blocked_entity = blocked_entity_match.group(1) if blocked_entity_match else None
    guardrail_name = guardrail_match.group(1).strip() if guardrail_match else None
    return guardrail_name, blocked_entity


def build_request_settings() -> tuple[str, str, float]:
    proxy_url = os.getenv("LITELLM_PROXY_URL", "").rstrip("/")
    api_key = os.getenv("LITELLM_API_KEY", "").strip()
    path = os.getenv("LITELLM_CHAT_COMPLETIONS_PATH", "/chat/completions").strip() or "/chat/completions"
    timeout = float(os.getenv("LITELLM_TIMEOUT_SECONDS", "120"))

    if not proxy_url:
        raise RuntimeError("LITELLM_PROXY_URL est manquant.")
    if not api_key:
        raise RuntimeError("LITELLM_API_KEY est manquant.")
    if not path.startswith("/"):
        path = f"/{path}"

    return f"{proxy_url}{path}", api_key, timeout


def resolve_model(cli_model: str | None) -> str:
    if cli_model and cli_model.strip():
        return cli_model.strip()

    for env_name in ("LITELLM_GEMINI_MODEL", "LITELLM_MISTRAL_MODEL", "LITELLM_OLLAMA_MODEL"):
        value = os.getenv(env_name, "").strip()
        if value:
            return value

    raise RuntimeError("Aucun modele LiteLLM trouve. Definis --model ou une variable LITELLM_*_MODEL.")


def call_litellm(*, model: str, prompt: str) -> tuple[str, str]:
    endpoint, api_key, timeout = build_request_settings()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
    }

    try:
        response = httpx.post(endpoint, headers=headers, json=payload, timeout=timeout)
        response.raise_for_status()
        return "allowed", extract_content(response.json())
    except httpx.HTTPStatusError as exc:
        body = exc.response.text.strip() if exc.response is not None else ""
        guardrail_name, blocked_entity = detect_guardrail(body)
        if exc.response is not None and exc.response.status_code == 500 and (guardrail_name or blocked_entity):
            details = []
            if guardrail_name:
                details.append(f"guardrail={guardrail_name}")
            if blocked_entity:
                details.append(f"blocked_entity={blocked_entity}")
            return "blocked", ", ".join(details)
        return "error", f"HTTP {exc.response.status_code if exc.response is not None else 'unknown'}: {body[:500]}"
    except httpx.TimeoutException:
        return "error", "Timeout LiteLLM."
    except httpx.HTTPError as exc:
        return "error", f"Erreur reseau LiteLLM: {exc}"


def find_emails(text: str) -> list[str]:
    seen: list[str] = []
    for match in EMAIL_REGEX.findall(text):
        if match not in seen:
            seen.append(match)
    return seen


def run_case(label: str, *, model: str, prompt: str) -> int:
    status, result = call_litellm(model=model, prompt=prompt)
    leaked_emails = find_emails(result) if status == "allowed" else []

    print(f"\n=== {label} ===")
    print(f"Model: {model}")
    print(f"Status: {status}")
    if leaked_emails:
        print(f"Output emails detected: {', '.join(leaked_emails)}")
    print("Prompt:")
    print(prompt)
    print("Result:")
    print(result)

    return 1 if status == "error" else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Test LiteLLM centre sur les prompts contenant des emails.")
    parser.add_argument("--model", help="Modele LiteLLM cible, ex: gemini/gemini-2.5-flash")
    parser.add_argument("--prompt", help="Prompt email personnalise a tester")
    parser.add_argument(
        "--mode",
        choices=["input", "output", "both"],
        default="both",
        help="Type de prompt email a envoyer",
    )
    return parser.parse_args()


def main() -> int:
    load_env()
    args = parse_args()
    model = resolve_model(args.model)

    if args.prompt:
        return run_case("custom-email", model=model, prompt=args.prompt)

    exit_code = 0
    if args.mode in {"input", "both"}:
        exit_code = max(exit_code, run_case("email-input", model=model, prompt=EMAIL_INPUT_PROMPT))
    if args.mode in {"output", "both"}:
        exit_code = max(exit_code, run_case("email-output", model=model, prompt=EMAIL_OUTPUT_PROMPT))
    return exit_code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Erreur: {exc}", file=sys.stderr)
        sys.exit(1)
