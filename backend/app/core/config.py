import os
from dotenv import load_dotenv

load_dotenv()


def _parse_csv_env(value: str | None) -> list[str]:
    return [item.strip() for item in (value or "").split(",") if item.strip()]


def _parse_bool_env(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    DB_HOST: str = os.getenv("DB_HOST", "localhost")
    DB_PORT: int = int(os.getenv("DB_PORT", "5432"))
    DB_NAME: str = os.getenv("DB_NAME", "catalog_AWB")
    DB_USER: str = os.getenv("DB_USER", "postgres")
    DB_PASSWORD: str = os.getenv("DB_PASSWORD", "password")
    NEO4J_URI: str = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    NEO4J_USER: str = os.getenv("NEO4J_USER", "neo4j")
    NEO4J_PASSWORD: str = os.getenv("NEO4J_PASSWORD", "")
    NEO4J_DATABASE: str = os.getenv("NEO4J_DATABASE", "neo4j")
    NEO4J_ENABLED: bool = os.getenv("NEO4J_ENABLED", "true").strip().lower() in {"1", "true", "yes", "on"}
    NVD_API_KEY: str = os.getenv("NVD_API_KEY", "")
    NVD_API_DELAY_SECONDS: float = float(os.getenv("NVD_API_DELAY_SECONDS", "1.2"))
    CVE_SYNC_ENABLED: bool = os.getenv("CVE_SYNC_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}
    CVE_SYNC_INTERVAL_MINUTES: int = int(os.getenv("CVE_SYNC_INTERVAL_MINUTES", "360"))
    CVE_SYNC_OVERLAP_HOURS: int = int(os.getenv("CVE_SYNC_OVERLAP_HOURS", "24"))
    CVE_SYNC_INITIAL_LOOKBACK_DAYS: int = int(os.getenv("CVE_SYNC_INITIAL_LOOKBACK_DAYS", "7"))
    CVE_SYNC_BATCH_SIZE: int = int(os.getenv("CVE_SYNC_BATCH_SIZE", "250"))
    CVE_SYNC_RESULTS_PER_PAGE: int = int(os.getenv("CVE_SYNC_RESULTS_PER_PAGE", "2000"))
    QDRANT_URL: str = os.getenv("QDRANT_URL", "")
    MISTRAL_API_KEY: str = os.getenv("MISTRAL_API_KEY", "")
    MISTRAL_MODEL: str = os.getenv("MISTRAL_MODEL", "mistral-medium-latest")
    MISTRAL_TIMEOUT_MS: int = int(os.getenv("MISTRAL_TIMEOUT_MS", "90000"))
    MISTRAL_MAX_RETRIES: int = int(os.getenv("MISTRAL_MAX_RETRIES", "2"))
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
    GEMINI_MODEL: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    OLLAMA_JUDGE_MODEL: str = os.getenv("OLLAMA_JUDGE_MODEL", "tensortemplar/prometheus2:7b-fp16")
    LITELLM_ENABLED: bool = _parse_bool_env(os.getenv("LITELLM_ENABLED"), default=False)
    LITELLM_PROXY_URL: str = os.getenv("LITELLM_PROXY_URL", "").rstrip("/")
    LITELLM_API_KEY: str = os.getenv("LITELLM_API_KEY", "").strip()
    LITELLM_CHAT_COMPLETIONS_PATH: str = os.getenv(
        "LITELLM_CHAT_COMPLETIONS_PATH",
        "/chat/completions",
    ).strip()
    LITELLM_TIMEOUT_SECONDS: float = float(os.getenv("LITELLM_TIMEOUT_SECONDS", "120"))
    LITELLM_MISTRAL_MODEL: str = os.getenv(
        "LITELLM_MISTRAL_MODEL",
        os.getenv("MISTRAL_MODEL", "mistral-medium-latest"),
    )
    LITELLM_GEMINI_MODEL: str = os.getenv(
        "LITELLM_GEMINI_MODEL",
        os.getenv("GEMINI_MODEL", "gemini-2.5-flash"),
    )
    LITELLM_OLLAMA_MODEL: str = os.getenv(
        "LITELLM_OLLAMA_MODEL",
        os.getenv("OLLAMA_JUDGE_MODEL", "tensortemplar/prometheus2:7b-fp16"),
    )
    MINIO_ENDPOINT: str = os.getenv("ENDPOINT", "")
    MINIO_ACCESS_KEY: str = os.getenv("ACCESS_KEY", "")
    MINIO_SECRET_KEY: str = os.getenv("SECRET_KEY", "")
    MINIO_BUCKET: str = os.getenv("BUCKET", "app-reports")
    CORS_ALLOWED_ORIGINS: list[str] = _parse_csv_env(
        os.getenv(
            "CORS_ALLOWED_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173",
        )
    )
    TRUSTED_HOSTS: list[str] = _parse_csv_env(
        os.getenv("TRUSTED_HOSTS", "localhost,127.0.0.1,testserver")
    )
    KEYCLOAK_URL: str = os.getenv("KEYCLOAK_URL", "http://localhost:8080").rstrip("/")
    KEYCLOAK_REALM: str = os.getenv("KEYCLOAK_REALM", "myrealm").strip()
    KEYCLOAK_ISSUER_EXPLICIT: bool = "KEYCLOAK_ISSUER" in os.environ
    KEYCLOAK_CERTS_URL_EXPLICIT: bool = "KEYCLOAK_CERTS_URL" in os.environ
    KEYCLOAK_ISSUER: str = os.getenv(
        "KEYCLOAK_ISSUER",
        f"{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}",
    ).rstrip("/")
    KEYCLOAK_CERTS_URL: str = os.getenv(
        "KEYCLOAK_CERTS_URL",
        f"{KEYCLOAK_ISSUER}/protocol/openid-connect/certs",
    ).rstrip("/")
    KEYCLOAK_AUDIENCE: str = os.getenv("KEYCLOAK_AUDIENCE", "").strip()
    KEYCLOAK_JWT_LEEWAY_SECONDS: int = int(os.getenv("KEYCLOAK_JWT_LEEWAY_SECONDS", "30"))
    DEBUG_INCLUDE_ERROR_CAUSE: bool = _parse_bool_env(
        os.getenv("DEBUG_INCLUDE_ERROR_CAUSE"),
        default=False,
    )
    MAX_DFD_UPLOAD_BYTES: int = int(os.getenv("MAX_DFD_UPLOAD_BYTES", str(5 * 1024 * 1024)))
    ANALYSIS_RATE_LIMIT_COUNT: int = int(os.getenv("ANALYSIS_RATE_LIMIT_COUNT", "5"))
    ANALYSIS_RATE_LIMIT_WINDOW_SECONDS: int = int(
        os.getenv("ANALYSIS_RATE_LIMIT_WINDOW_SECONDS", "300")
    )
    SECOPS_CHAT_RATE_LIMIT_COUNT: int = int(os.getenv("SECOPS_CHAT_RATE_LIMIT_COUNT", "30"))
    SECOPS_CHAT_RATE_LIMIT_WINDOW_SECONDS: int = int(
        os.getenv("SECOPS_CHAT_RATE_LIMIT_WINDOW_SECONDS", "60")
    )
    SECOPS_CHAT_REQUIRE_SCOPE_ALLOWLIST: bool = _parse_bool_env(
        os.getenv("SECOPS_CHAT_REQUIRE_SCOPE_ALLOWLIST"),
        default=True,
    )
    SECOPS_CHAT_GENERAL_MODE: bool = _parse_bool_env(
        os.getenv("SECOPS_CHAT_GENERAL_MODE"),
        default=False,
    )
    ADMIN_RATE_LIMIT_COUNT: int = int(os.getenv("ADMIN_RATE_LIMIT_COUNT", "120"))
    ADMIN_RATE_LIMIT_WINDOW_SECONDS: int = int(
        os.getenv("ADMIN_RATE_LIMIT_WINDOW_SECONDS", "60")
    )
    DFD_STUDIO_RENDER_ENABLED: bool = _parse_bool_env(
        os.getenv("DFD_STUDIO_RENDER_ENABLED"),
        default=True,
    )
    DFD_STUDIO_RENDER_URL: str = os.getenv(
        "DFD_STUDIO_RENDER_URL",
        "http://localhost:5173/dfd-render",
    ).strip()
    DFD_STUDIO_RENDER_TIMEOUT_MS: int = int(
        os.getenv("DFD_STUDIO_RENDER_TIMEOUT_MS", "45000")
    )
    DFD_STUDIO_BROWSER_PATH: str = os.getenv("DFD_STUDIO_BROWSER_PATH", "").strip()

settings = Settings()
