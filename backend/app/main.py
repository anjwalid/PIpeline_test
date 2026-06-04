import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from prometheus_fastapi_instrumentator import Instrumentator

from app.api.admin_catalog import router as admin_catalog_router
from app.api.admin_cve_graph import router as admin_cve_graph_router
from app.api.admin_audit import router as admin_audit_router
from app.api.admin_knowledge import router as admin_knowledge_router
from app.api.admin_questionnaire import router as admin_questionnaire_router
from app.api.admin_regulatory import router as admin_regulatory_router
from app.api.analysis import router as analysis_router
from app.api.llm_feedback import router as llm_feedback_router
from app.api.questionnaire import router as questionnaire_router
from app.api.reports import router as reports_router
from app.api.secops_chat import router as secops_chat_router
from app.core.config import settings
from app.repositories.questionnaire_repository import QuestionnaireRepository
from app.services.audit_service import AuditService
from app.services.cve_sync_service import CveSyncService
from app.services.faq_service import build_faq_index
from app.services.rag_service import build_index
from app.services.report_management_service import ReportManagementService

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)


app = FastAPI(title="AWB Backend", version="1.0.0")


@app.on_event("startup")
def startup_prepare_schema():
    ReportManagementService.ensure_schema()
    QuestionnaireRepository.ensure_schema()
    AuditService.ensure_schema()
    CveSyncService.start()
    build_index()
    build_faq_index()


@app.on_event("shutdown")
def shutdown_background_services():
    CveSyncService.stop()


if settings.TRUSTED_HOSTS and "*" not in settings.TRUSTED_HOSTS:
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=settings.TRUSTED_HOSTS,
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return response


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception(
        "Unhandled backend exception: path=%s method=%s",
        request.url.path,
        request.method,
    )
    return JSONResponse(
        status_code=500,
        content={
            "detail": {
                "error_type": "UNHANDLED_EXCEPTION",
                "step": "global_exception_handler",
                "message": "Une erreur non geree est survenue dans le backend.",
                "cause": str(exc) if settings.DEBUG_INCLUDE_ERROR_CAUSE else None,
                "path": request.url.path,
                "method": request.method,
            }
        },
    )


@app.get("/health")
def health_check():
    return {"status": "ok"}


app.include_router(questionnaire_router)
app.include_router(admin_questionnaire_router)
app.include_router(admin_catalog_router)
app.include_router(admin_cve_graph_router)
app.include_router(admin_audit_router)
app.include_router(analysis_router)
app.include_router(reports_router)
app.include_router(llm_feedback_router)
app.include_router(secops_chat_router)
app.include_router(admin_regulatory_router)
app.include_router(admin_knowledge_router)

Instrumentator(
    should_group_status_codes=True,
    should_ignore_untemplated=True,
    excluded_handlers=["/health", "/metrics"],
).instrument(app).expose(app, endpoint="/metrics")


@app.get("/")
def root():
    return {"message": "AWB FastAPI backend is running"}
