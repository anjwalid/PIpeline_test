BEGIN;

ALTER TABLE report_results
ADD COLUMN IF NOT EXISTS dfd_reference TEXT DEFAULT 'DFD-01';

ALTER TABLE report_results
ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS report_result_versions (
    id BIGSERIAL PRIMARY KEY,
    report_id UUID NOT NULL
        REFERENCES reports(id)
        ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    version_label TEXT NOT NULL,
    app_name TEXT NOT NULL,
    developer_name TEXT NOT NULL,
    application_description TEXT NOT NULL,
    selected_threats JSONB NOT NULL,
    dfd_image_path TEXT,
    dfd_reference TEXT,
    created_by UUID,
    created_by_username TEXT,
    created_by_email TEXT,
    change_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_report_result_versions UNIQUE (report_id, version_number)
);

COMMIT;
