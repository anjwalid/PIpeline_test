from typing import Any, Dict, List, Optional

from app.core.database import get_connection


class QuestionnaireRepository:
    @staticmethod
    def ensure_schema():
        conn = get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS question_option_visibility_rule (
                            id SERIAL PRIMARY KEY,
                            question_option_id INT NOT NULL REFERENCES question_option(id) ON DELETE CASCADE,
                            depends_on_question_id INT NOT NULL REFERENCES question(id) ON DELETE CASCADE,
                            operator VARCHAR(20) NOT NULL DEFAULT 'equals',
                            expected_value VARCHAR(255) NOT NULL
                        )
                        """
                    )
                    cur.execute(
                        """
                        CREATE INDEX IF NOT EXISTS idx_qovr_option_id
                        ON question_option_visibility_rule (question_option_id)
                        """
                    )
                    cur.execute(
                        """
                        CREATE INDEX IF NOT EXISTS idx_qovr_depends_question_id
                        ON question_option_visibility_rule (depends_on_question_id)
                        """
                    )
                    cur.execute(
                        """
                        ALTER TABLE question
                        ADD COLUMN IF NOT EXISTS aide TEXT
                        """
                    )
        finally:
            conn.close()

    @staticmethod
    def _normalize_requested_order(value: Any) -> int:
        try:
            normalized = int(value)
        except (TypeError, ValueError):
            return 1
        return max(1, normalized)

    @staticmethod
    def _normalize_ordered_items(items: List[Dict[str, Any]], order_key: str) -> List[Dict[str, Any]]:
        decorated_items = []
        for index, item in enumerate(items):
            normalized_item = dict(item)
            decorated_items.append(
                (
                    QuestionnaireRepository._normalize_requested_order(
                        normalized_item.get(order_key)
                    ),
                    index,
                    normalized_item,
                )
            )

        normalized_list: List[Dict[str, Any]] = []
        for new_order, (_, _, item) in enumerate(sorted(decorated_items, key=lambda entry: (entry[0], entry[1])), start=1):
            item[order_key] = new_order
            normalized_list.append(item)

        return normalized_list

    @staticmethod
    def _normalize_questionnaire_structure(steps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        normalized_steps = QuestionnaireRepository._normalize_ordered_items(steps, "step_order")

        for step in normalized_steps:
            step["questions"] = QuestionnaireRepository._normalize_ordered_items(
                step.get("questions", []),
                "display_order",
            )

            for question in step["questions"]:
                question["options"] = QuestionnaireRepository._normalize_ordered_items(
                    question.get("options", []),
                    "display_order",
                )

        return normalized_steps

    @staticmethod
    def _get_question_columns(cur) -> set[str]:
        cur.execute(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'question'
            """
        )
        return {row["column_name"] for row in cur.fetchall()}

    @staticmethod
    def list_questionnaires():
        QuestionnaireRepository.ensure_schema()
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, code, name, version, status, is_active
                    FROM questionnaire
                    ORDER BY updated_at DESC, id DESC
                    """
                )
                return cur.fetchall()
        finally:
            conn.close()

    @staticmethod
    def get_questionnaire_by_id(questionnaire_id: int):
        QuestionnaireRepository.ensure_schema()
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                return QuestionnaireRepository._fetch_questionnaire_tree(cur, questionnaire_id)
        finally:
            conn.close()

    @staticmethod
    def get_questionnaire_by_code(code: str, active_only: bool = False):
        QuestionnaireRepository.ensure_schema()
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                if active_only:
                    cur.execute(
                        """
                        SELECT id
                        FROM questionnaire
                        WHERE code = %s AND is_active = TRUE
                        LIMIT 1
                        """,
                        (code,),
                    )
                else:
                    cur.execute(
                        """
                        SELECT id
                        FROM questionnaire
                        WHERE code = %s
                        LIMIT 1
                        """,
                        (code,),
                    )

                questionnaire = cur.fetchone()
                if not questionnaire:
                    return None

                return QuestionnaireRepository._fetch_questionnaire_tree(cur, questionnaire["id"])
        finally:
            conn.close()

    @staticmethod
    def get_active_questionnaire_by_code(code: str):
        return QuestionnaireRepository.get_questionnaire_by_code(code, active_only=True)

    @staticmethod
    def get_active_questionnaire():
        QuestionnaireRepository.ensure_schema()
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id
                    FROM questionnaire
                    WHERE is_active = TRUE
                    ORDER BY updated_at DESC, id DESC
                    LIMIT 1
                    """
                )
                questionnaire = cur.fetchone()
                if not questionnaire:
                    return None

                return QuestionnaireRepository._fetch_questionnaire_tree(cur, questionnaire["id"])
        finally:
            conn.close()

    @staticmethod
    def create_questionnaire(payload: Dict[str, Any]):
        QuestionnaireRepository.ensure_schema()
        conn = get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    questionnaire_id = QuestionnaireRepository._upsert_questionnaire_record(cur, payload)
                    QuestionnaireRepository._replace_questionnaire_children(
                        cur,
                        questionnaire_id,
                        payload.get("code", ""),
                        payload.get("steps", []),
                    )
                    return QuestionnaireRepository._fetch_questionnaire_tree(cur, questionnaire_id)
        finally:
            conn.close()

    @staticmethod
    def update_questionnaire(questionnaire_id: int, payload: Dict[str, Any]):
        QuestionnaireRepository.ensure_schema()
        conn = get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT id
                        FROM questionnaire
                        WHERE id = %s
                        LIMIT 1
                        """,
                        (questionnaire_id,),
                    )
                    existing_questionnaire = cur.fetchone()
                    if not existing_questionnaire:
                        return None

                    cur.execute(
                        """
                        SELECT code
                        FROM questionnaire
                        WHERE id = %s
                        LIMIT 1
                        """,
                        (questionnaire_id,),
                    )
                    existing_questionnaire_code = (cur.fetchone() or {}).get("code", "")

                    cur.execute(
                        """
                        UPDATE questionnaire
                        SET code = %s,
                            name = %s,
                            version = %s,
                            status = %s,
                            is_active = %s,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = %s
                        """,
                        (
                            payload["code"],
                            payload["name"],
                            payload.get("version", 1),
                            payload.get("status", "draft"),
                            payload.get("is_active", False),
                            questionnaire_id,
                        ),
                    )

                    cur.execute(
                        "DELETE FROM questionnaire_step WHERE questionnaire_id = %s",
                        (questionnaire_id,),
                    )
                    QuestionnaireRepository._delete_answer_context_rows(
                        cur,
                        questionnaire_codes=[
                            existing_questionnaire_code,
                            payload.get("code", ""),
                        ],
                    )
                    QuestionnaireRepository._replace_questionnaire_children(
                        cur,
                        questionnaire_id,
                        payload.get("code", ""),
                        payload.get("steps", []),
                    )
                    return QuestionnaireRepository._fetch_questionnaire_tree(cur, questionnaire_id)
        finally:
            conn.close()

    @staticmethod
    def delete_questionnaire(questionnaire_id: int):
        QuestionnaireRepository.ensure_schema()
        conn = get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT code
                        FROM questionnaire
                        WHERE id = %s
                        LIMIT 1
                        """,
                        (questionnaire_id,),
                    )
                    questionnaire = cur.fetchone()
                    if questionnaire:
                        QuestionnaireRepository._delete_answer_context_rows(
                            cur,
                            questionnaire_codes=[questionnaire.get("code", "")],
                        )
                    cur.execute("DELETE FROM questionnaire WHERE id = %s", (questionnaire_id,))
                    return cur.rowcount > 0
        finally:
            conn.close()

    @staticmethod
    def _upsert_questionnaire_record(cur, payload: Dict[str, Any]) -> int:
        cur.execute(
            """
            INSERT INTO questionnaire (code, name, version, status, is_active)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                payload["code"],
                payload["name"],
                payload.get("version", 1),
                payload.get("status", "draft"),
                payload.get("is_active", False),
            ),
        )
        return cur.fetchone()["id"]

    @staticmethod
    def _replace_questionnaire_children(
        cur,
        questionnaire_id: int,
        questionnaire_code: str,
        steps: List[Dict[str, Any]],
    ):
        step_code_to_id: Dict[str, int] = {}
        question_code_to_id: Dict[str, int] = {}
        deferred_rules: List[Dict[str, Any]] = []
        deferred_option_rules: List[Dict[str, Any]] = []
        deferred_contexts: List[Dict[str, Any]] = []
        question_columns = QuestionnaireRepository._get_question_columns(cur)
        normalized_steps = QuestionnaireRepository._normalize_questionnaire_structure(steps)

        for step in normalized_steps:
            cur.execute(
                """
                INSERT INTO questionnaire_step (questionnaire_id, code, title, step_order)
                VALUES (%s, %s, %s, %s)
                RETURNING id
                """,
                (
                    questionnaire_id,
                    step["code"],
                    step["title"],
                    step["step_order"],
                ),
            )
            step_id = cur.fetchone()["id"]
            step_code_to_id[step["code"]] = step_id

            for question in step.get("questions", []):
                insert_columns = [
                    "step_id",
                    "code",
                    "label",
                    "help_text",
                    "aide",
                    "question_type",
                    "is_required",
                    "display_order",
                    "is_active",
                ]
                insert_values: List[Any] = [
                    step_id,
                    question["code"],
                    question["label"],
                    question.get("help_text"),
                    question.get("aide"),
                    question["question_type"],
                    question.get("is_required", False),
                    question["display_order"],
                    question.get("is_active", True),
                ]

                if "default_value" in question_columns:
                    insert_columns.append("default_value")
                    insert_values.append(question.get("default_value"))

                if "backend_key" in question_columns:
                    insert_columns.append("backend_key")
                    insert_values.append(question.get("backend_key"))

                if "send_if_true_only" in question_columns:
                    insert_columns.append("send_if_true_only")
                    insert_values.append(question.get("send_if_true_only", False))

                placeholders = ", ".join(["%s"] * len(insert_columns))
                columns_sql = ", ".join(insert_columns)
                cur.execute(
                    f"""
                    INSERT INTO question ({columns_sql})
                    VALUES ({placeholders})
                    RETURNING id
                    """,
                    tuple(insert_values),
                )
                question_id = cur.fetchone()["id"]
                question_code_to_id[question["code"]] = question_id

                for option in question.get("options", []):
                    cur.execute(
                        """
                        INSERT INTO question_option (question_id, label, value, display_order)
                        VALUES (%s, %s, %s, %s)
                        RETURNING id
                        """,
                        (
                            question_id,
                            option["label"],
                            option["value"],
                            option["display_order"],
                        ),
                    )
                    option_id = cur.fetchone()["id"]

                    for option_rule in option.get("visibility_rules", []):
                        deferred_option_rules.append(
                            {
                                "question_option_id": option_id,
                                "depends_on_question_code": option_rule["depends_on_question_code"],
                                "operator": option_rule["operator"],
                                "expected_value": option_rule["expected_value"],
                            }
                        )

                for rule in question.get("visibility_rules", []):
                    deferred_rules.append(
                        {
                            "question_code": question["code"],
                            "depends_on_question_code": rule["depends_on_question_code"],
                            "operator": rule["operator"],
                            "expected_value": rule["expected_value"],
                        }
                    )

                for answer_context in question.get("answer_contexts", []):
                    deferred_contexts.append(
                        {
                            "question_code": question["code"],
                            "option_value": str(answer_context.get("option_value") or "").strip(),
                            "context_category": str(
                                answer_context.get("context_category") or ""
                            ).strip(),
                            "llm_sentence": str(answer_context.get("llm_sentence") or "").strip(),
                            "diagram_hint": str(answer_context.get("diagram_hint") or "").strip(),
                        }
                    )

        for rule in deferred_rules:
            depends_on_question_id = question_code_to_id.get(rule["depends_on_question_code"])
            question_id = question_code_to_id.get(rule["question_code"])

            if not question_id or not depends_on_question_id:
                continue

            cur.execute(
                """
                INSERT INTO question_visibility_rule (
                    question_id, depends_on_question_id, operator, expected_value
                )
                VALUES (%s, %s, %s, %s)
                """,
                (
                    question_id,
                    depends_on_question_id,
                    rule["operator"],
                    rule["expected_value"],
                ),
            )

        for option_rule in deferred_option_rules:
            depends_on_question_id = question_code_to_id.get(option_rule["depends_on_question_code"])
            question_option_id = option_rule["question_option_id"]

            if not question_option_id or not depends_on_question_id:
                continue

            cur.execute(
                """
                INSERT INTO question_option_visibility_rule (
                    question_option_id, depends_on_question_id, operator, expected_value
                )
                VALUES (%s, %s, %s, %s)
                """,
                (
                    question_option_id,
                    depends_on_question_id,
                    option_rule["operator"],
                    option_rule["expected_value"],
                ),
            )

        QuestionnaireRepository._insert_answer_context_rows(
            cur,
            questionnaire_code=questionnaire_code,
            answer_context_rows=deferred_contexts,
        )

    @staticmethod
    def _delete_answer_context_rows(cur, questionnaire_codes: List[str]):
        normalized_codes = [str(code or "").strip() for code in questionnaire_codes if str(code or "").strip()]
        if not normalized_codes:
            return

        cur.execute(
            """
            DELETE FROM questionnaire_answer_context
            WHERE questionnaire_code = ANY(%s)
            """,
            (normalized_codes,),
        )

    @staticmethod
    def _insert_answer_context_rows(cur, questionnaire_code: str, answer_context_rows: List[Dict[str, Any]]):
        normalized_questionnaire_code = str(questionnaire_code or "").strip()
        if not normalized_questionnaire_code:
            return

        for row in answer_context_rows:
            option_value = str(row.get("option_value") or "").strip()
            if not option_value:
                continue

            cur.execute(
                """
                INSERT INTO questionnaire_answer_context (
                    questionnaire_code,
                    question_code,
                    option_value,
                    context_category,
                    llm_sentence,
                    diagram_hint
                )
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (
                    normalized_questionnaire_code,
                    row["question_code"],
                    option_value,
                    row.get("context_category") or None,
                    row.get("llm_sentence") or None,
                    row.get("diagram_hint") or None,
                ),
            )

    @staticmethod
    def _fetch_questionnaire_tree(cur, questionnaire_id: int):
        question_columns = QuestionnaireRepository._get_question_columns(cur)
        default_value_expr = "q.default_value" if "default_value" in question_columns else "NULL::text"
        aide_expr = "q.aide" if "aide" in question_columns else "q.help_text"
        backend_key_expr = (
            "COALESCE(q.backend_key, ''::text)"
            if "backend_key" in question_columns
            else "''::text"
        )
        send_if_true_only_expr = (
            "COALESCE(q.send_if_true_only, FALSE)"
            if "send_if_true_only" in question_columns
            else "FALSE"
        )

        cur.execute(
            """
            SELECT id, code, name, version, status, is_active
            FROM questionnaire
            WHERE id = %s
            LIMIT 1
            """,
            (questionnaire_id,),
        )
        questionnaire = cur.fetchone()
        if not questionnaire:
            return None

        cur.execute(
            """
            SELECT id, questionnaire_id, code, title, step_order
            FROM questionnaire_step
            WHERE questionnaire_id = %s
            ORDER BY step_order, id
            """,
            (questionnaire_id,),
        )
        steps = cur.fetchall()
        cur.execute(
            f"""
            SELECT
                q.id,
                q.step_id,
                s.code AS step_code,
                q.code,
                q.label,
                q.help_text,
                {aide_expr} AS aide,
                q.question_type,
                q.is_required,
                q.display_order,
                {default_value_expr} AS default_value,
                q.is_active,
                {backend_key_expr} AS backend_key,
                {send_if_true_only_expr} AS send_if_true_only
            FROM question q
            INNER JOIN questionnaire_step s ON s.id = q.step_id
            WHERE s.questionnaire_id = %s
            ORDER BY s.step_order, q.display_order, q.id
            """,
            (questionnaire_id,),
        )
        questions = cur.fetchall()
        cur.execute(
            """
            SELECT id, question_id, label, value, display_order
            FROM question_option
            WHERE question_id IN (
                SELECT q.id
                FROM question q
                INNER JOIN questionnaire_step s ON s.id = q.step_id
                WHERE s.questionnaire_id = %s
            )
            ORDER BY question_id, display_order, id
            """,
            (questionnaire_id,),
        )
        options = cur.fetchall()

        cur.execute(
            """
            SELECT
                r.id,
                r.question_option_id,
                qo.value AS option_value,
                r.depends_on_question_id,
                dq.code AS depends_on_question_code,
                r.operator,
                r.expected_value
            FROM question_option_visibility_rule r
            INNER JOIN question_option qo ON qo.id = r.question_option_id
            LEFT JOIN question dq ON dq.id = r.depends_on_question_id
            WHERE qo.question_id IN (
                SELECT q.id
                FROM question q
                INNER JOIN questionnaire_step s ON s.id = q.step_id
                WHERE s.questionnaire_id = %s
            )
            ORDER BY r.question_option_id, r.id
            """,
            (questionnaire_id,),
        )
        option_visibility_rules = cur.fetchall()

        cur.execute(
            """
            SELECT
                r.id,
                r.question_id,
                q.code AS question_code,
                r.depends_on_question_id,
                dq.code AS depends_on_question_code,
                r.operator,
                r.expected_value
            FROM question_visibility_rule r
            INNER JOIN question q ON q.id = r.question_id
            LEFT JOIN question dq ON dq.id = r.depends_on_question_id
            WHERE q.step_id IN (
                SELECT id
                FROM questionnaire_step
                WHERE questionnaire_id = %s
            )
            ORDER BY r.id
            """,
            (questionnaire_id,),
        )
        visibility_rules = cur.fetchall()

        cur.execute(
            """
            SELECT
                id,
                questionnaire_code,
                question_code,
                option_value,
                context_category,
                llm_sentence,
                diagram_hint
            FROM questionnaire_answer_context
            WHERE questionnaire_code = %s
            ORDER BY question_code, option_value, id
            """,
            (questionnaire["code"],),
        )
        answer_context_rows = cur.fetchall()

        options_by_question: Dict[int, List[Dict[str, Any]]] = {}
        for option in options:
            options_by_question.setdefault(option["question_id"], []).append(option)

        rules_by_option: Dict[int, List[Dict[str, Any]]] = {}
        for rule in option_visibility_rules:
            rules_by_option.setdefault(rule["question_option_id"], []).append(rule)

        for option in options:
            option["visibility_rules"] = rules_by_option.get(option["id"], [])

        rules_by_question: Dict[int, List[Dict[str, Any]]] = {}
        for rule in visibility_rules:
            rules_by_question.setdefault(rule["question_id"], []).append(rule)

        contexts_by_question_code: Dict[str, List[Dict[str, Any]]] = {}
        for row in answer_context_rows:
            contexts_by_question_code.setdefault(row["question_code"], []).append(row)

        formatted_questions = []
        for question in questions:
            formatted_questions.append(
                {
                    **question,
                    "options": options_by_question.get(question["id"], []),
                    "visibility_rules": rules_by_question.get(question["id"], []),
                    "answer_contexts": contexts_by_question_code.get(question["code"], []),
                }
            )

        return {
            **questionnaire,
            "steps": steps,
            "questions": formatted_questions,
        }
