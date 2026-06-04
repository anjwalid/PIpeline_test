from typing import Annotated

from fastapi import APIRouter, Depends, File, Response, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse

from app.core.auth import AuthenticatedUser, get_current_user
from app.schemas.report import (
    ManagerDashboardMetricsResponse,
    ReportDfdUploadResponse,
    ReportResponse,
    ReportResultsResponse,
    ReportResultsUpdateRequest,
    ReportStatusUpdateRequest,
)
from app.services.report_management_service import ReportManagementService

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/me", response_model=list[ReportResponse])
def list_my_reports(current_user: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    return ReportManagementService.list_my_reports(current_user)


@router.get("", response_model=list[ReportResponse])
def list_all_reports(current_user: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    return ReportManagementService.list_all_reports(current_user)


@router.get("/dashboard/manager", response_model=ManagerDashboardMetricsResponse)
def get_manager_dashboard_metrics(
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    return ReportManagementService.get_manager_dashboard_metrics(current_user)


@router.get("/{report_id}", response_model=ReportResponse)
def get_report(report_id: str, current_user: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    return ReportManagementService.get_report(report_id, current_user)


@router.delete("/{report_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_report(
    report_id: str,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    ReportManagementService.delete_report(report_id, current_user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch("/{report_id}/status", response_model=ReportResponse)
def update_report_status(
    report_id: str,
    payload: ReportStatusUpdateRequest,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    return ReportManagementService.update_report_status(
        report_id=report_id,
        new_status=payload.status,
        actor=current_user,
        comment=payload.comment,
        feedback_items=payload.feedback_items,
    )


@router.get("/{report_id}/results", response_model=ReportResultsResponse)
def get_report_results(
    report_id: str,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    return ReportManagementService.get_report_results(report_id, current_user)


@router.put("/{report_id}/results", response_model=ReportResultsResponse)
def update_report_results(
    report_id: str,
    payload: ReportResultsUpdateRequest,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    return ReportManagementService.update_report_results(
        report_id=report_id,
        app_name=payload.app_name,
        developer_name=payload.developer_name,
        application_description=payload.application_description,
        selected_threats=payload.selected_threats,
        dfd_json=payload.dfd_json.model_dump(),
        dfd_image_path=payload.dfd_image_path,
        dfd_reference=payload.dfd_reference,
        actor=current_user,
        modification_reasons=payload.modification_reasons,
        modification_comment=payload.modification_comment,
    )


@router.post("/{report_id}/regenerate", response_model=ReportResponse)
def regenerate_report(
    report_id: str,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    return ReportManagementService.regenerate_report(report_id, current_user)


@router.post("/{report_id}/dfd-upload", response_model=ReportDfdUploadResponse)
def upload_report_dfd(
    report_id: str,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
    dfd_file: UploadFile = File(...),
):
    return ReportManagementService.save_uploaded_dfd(
        report_id=report_id,
        original_file_name=dfd_file.filename or "dfd-upload.png",
        file_stream=dfd_file.file,
        actor=current_user,
    )


@router.get("/{report_id}/download", include_in_schema=False)
def download_report(
    report_id: str,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    payload = ReportManagementService.get_download_payload(report_id, current_user)
    report = payload["report"]
    local_path = payload.get("local_path")
    object_response = payload["object_response"]

    if local_path:
        return FileResponse(
            path=local_path,
            media_type=report["file_type"],
            filename=report["file_name"],
            headers={"Content-Disposition": "inline"},
        )

    def iterator():
        try:
            # MinIO python client returns an urllib3 HTTPResponse.
            for chunk in object_response.stream(64 * 1024):
                if not chunk:
                    continue
                yield chunk
        finally:
            try:
                object_response.close()
            finally:
                if hasattr(object_response, "release_conn"):
                    object_response.release_conn()

    return StreamingResponse(
        iterator(),
        media_type=report["file_type"],
        headers={
            "Content-Disposition": f'inline; filename="{report["file_name"]}"',
        },
    )


@router.get("/{report_id}/versions/{version_number}/download", include_in_schema=False)
def download_report_version(
    report_id: str,
    version_number: int,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    payload = ReportManagementService.get_version_download_payload(
        report_id,
        version_number,
        current_user,
    )
    report = payload["report"]
    local_path = payload.get("local_path")
    object_response = payload["object_response"]

    if local_path:
        return FileResponse(
            path=local_path,
            media_type=report["file_type"],
            filename=report["file_name"],
            headers={"Content-Disposition": "inline"},
        )

    def iterator():
        try:
            for chunk in object_response.stream(64 * 1024):
                if not chunk:
                    continue
                yield chunk
        finally:
            try:
                object_response.close()
            finally:
                if hasattr(object_response, "release_conn"):
                    object_response.release_conn()

    return StreamingResponse(
        iterator(),
        media_type=report["file_type"],
        headers={
            "Content-Disposition": f'inline; filename="{report["file_name"]}"',
        },
    )
