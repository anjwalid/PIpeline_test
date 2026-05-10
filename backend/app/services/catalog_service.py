from typing import Any, Dict

from app.repositories.catalog_repository import CatalogRepository


class CatalogService:
    @staticmethod
    def list_references():
        return CatalogRepository.list_references()

    @staticmethod
    def list_reference_groups():
        return CatalogRepository.list_reference_groups()

    @staticmethod
    def create_reference(payload: Dict[str, Any]):
        return CatalogRepository.create_reference(payload)

    @staticmethod
    def update_reference(reference_id: int, payload: Dict[str, Any]):
        return CatalogRepository.update_reference(reference_id, payload)

    @staticmethod
    def delete_reference(reference_id: int):
        return CatalogRepository.delete_reference(reference_id)

    @staticmethod
    def list_threats():
        return CatalogRepository.list_threats()

    @staticmethod
    def get_threat_by_id(threat_id: int):
        return CatalogRepository.get_threat_by_id(threat_id)

    @staticmethod
    def create_threat(payload: Dict[str, Any]):
        return CatalogRepository.create_threat(payload)

    @staticmethod
    def update_threat(threat_id: int, payload: Dict[str, Any]):
        return CatalogRepository.update_threat(threat_id, payload)

    @staticmethod
    def delete_threat(threat_id: int):
        return CatalogRepository.delete_threat(threat_id)

    @staticmethod
    def trigger_catalog_refresh():
        return {
            "status": "pending",
            "message": "Le processus de mise a jour automatique du catalogue sera branche dans une prochaine iteration.",
        }
