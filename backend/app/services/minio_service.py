import logging
from pathlib import Path
from tempfile import NamedTemporaryFile
from minio import Minio
from minio.error import S3Error
from urllib.parse import urlparse

from app.core.config import settings

logger = logging.getLogger(__name__)


class MinioService:
    LOCAL_BUCKET = "__local_temp__"

    @staticmethod
    def _normalize_endpoint(raw_endpoint: str) -> tuple[str, bool]:
        cleaned = (raw_endpoint or "").strip()
        if not cleaned:
            raise RuntimeError("ENDPOINT MinIO manquant.")

        # Tolerate malformed values like http://host::9000
        cleaned = cleaned.replace("::", ":")
        if "://" not in cleaned:
            cleaned = f"http://{cleaned}"

        parsed = urlparse(cleaned)
        endpoint = parsed.netloc or parsed.path
        if not endpoint:
            raise RuntimeError(f"Endpoint MinIO invalide: {raw_endpoint}")

        logger.info(
            "MinIO endpoint normalise: endpoint=%s secure=%s",
            endpoint.rstrip("/"),
            parsed.scheme == "https",
        )
        return endpoint.rstrip("/"), parsed.scheme == "https"

    @staticmethod
    def _client() -> Minio:
        endpoint, secure = MinioService._normalize_endpoint(settings.MINIO_ENDPOINT)

        return Minio(
            endpoint,
            access_key=settings.MINIO_ACCESS_KEY,
            secret_key=settings.MINIO_SECRET_KEY,
            secure=secure,
        )

    @staticmethod
    def ensure_bucket_exists() -> None:
        client = MinioService._client()
        bucket = settings.MINIO_BUCKET

        try:
            exists = client.bucket_exists(bucket)
        except Exception as exc:
            raise RuntimeError(
                f"Echec verification bucket MinIO '{bucket}' sur endpoint '{settings.MINIO_ENDPOINT}': {exc}"
            ) from exc

        if not exists:
            raise RuntimeError(
                f"Bucket MinIO introuvable: {bucket} sur endpoint '{settings.MINIO_ENDPOINT}'"
            )

    @staticmethod
    def upload_file(file_path: str, object_key: str, content_type: str) -> dict:
        client = MinioService._client()
        bucket = settings.MINIO_BUCKET

        MinioService.ensure_bucket_exists()

        file_obj = Path(file_path)

        try:
            client.fput_object(
                bucket,
                object_key,
                str(file_obj),
                content_type=content_type,
            )
        except Exception as exc:
            raise RuntimeError(
                f"Echec upload MinIO bucket='{bucket}' object_key='{object_key}' file='{file_obj}': {exc}"
            ) from exc

        return {
            "bucket": bucket,
            "object_key": object_key,
            "file_size": file_obj.stat().st_size,
        }

    @staticmethod
    def upload_bytes(
        *,
        data: bytes,
        object_key: str,
        content_type: str,
    ) -> dict:
        client = MinioService._client()
        bucket = settings.MINIO_BUCKET

        MinioService.ensure_bucket_exists()

        try:
            from io import BytesIO

            payload = BytesIO(data)
            client.put_object(
                bucket,
                object_key,
                payload,
                length=len(data),
                content_type=content_type,
            )
        except Exception as exc:
            raise RuntimeError(
                f"Echec upload bytes MinIO bucket='{bucket}' object_key='{object_key}': {exc}"
            ) from exc

        return {
            "bucket": bucket,
            "object_key": object_key,
            "file_size": len(data),
        }

    @staticmethod
    def build_minio_uri(bucket: str, object_key: str) -> str:
        return f"minio://{bucket}/{object_key.lstrip('/')}"

    @staticmethod
    def parse_minio_uri(uri: str) -> tuple[str, str] | None:
        if not uri or not uri.startswith("minio://"):
            return None

        parsed = urlparse(uri)
        bucket = parsed.netloc
        object_key = parsed.path.lstrip("/")
        if not bucket or not object_key:
            return None
        return bucket, object_key

    @staticmethod
    def download_object_to_temp_file(
        *,
        bucket_name: str,
        object_key: str,
        suffix: str = "",
    ) -> str:
        client = MinioService._client()
        response = None

        try:
            response = client.get_object(bucket_name, object_key)
            with NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
                for chunk in response.stream(64 * 1024):
                    if chunk:
                        temp_file.write(chunk)
                temp_path = temp_file.name
        except Exception as exc:
            raise RuntimeError(
                f"Echec telechargement MinIO bucket='{bucket_name}' object_key='{object_key}': {exc}"
            ) from exc
        finally:
            try:
                response.close()
            except Exception:
                pass
            try:
                if hasattr(response, "release_conn"):
                    response.release_conn()
            except Exception:
                pass

        return temp_path

    @staticmethod
    def get_object(bucket_name: str, object_key: str):
        if bucket_name == MinioService.LOCAL_BUCKET:
            return Path(object_key)

        client = MinioService._client()

        try:
            return client.get_object(bucket_name, object_key)
        except S3Error as e:
            raise RuntimeError(
                f"Echec lecture MinIO bucket='{bucket_name}' object_key='{object_key}': {e}"
            ) from e
