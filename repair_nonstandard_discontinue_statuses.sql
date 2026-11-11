-- Repair only non-standard statuses in the active discontinue workflow
-- (sheet_rows.sheet_name = 'Response'), deriving the status from reasons.
--
-- Rules:
--   SCM + HOF + Manager -> PENDING_HEAD_OFFICE
--   SCM only            -> PENDING_HOF_MANAGER
--   SCM + HOF           -> WAITING_FOR_MANAGER
--   SCM + Manager       -> WAITING_FOR_HOF
--
-- Existing standard statuses are deliberately left unchanged. Rows with
-- no SCM reason, or a reason combination not listed above, are left unchanged.
-- SAFETY: this script ends with ROLLBACK. Review the preview before changing
-- the final ROLLBACK to COMMIT and running the entire script again.

BEGIN;

CREATE TEMP TABLE discontinue_status_repairs (
    row_id BIGINT PRIMARY KEY,
    current_status TEXT,
    derived_status TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO discontinue_status_repairs (row_id, current_status, derived_status)
SELECT id,
       data->>'Status',
       CASE
           WHEN has_hof_reason AND has_manager_reason
               THEN 'PENDING_HEAD_OFFICE'
           WHEN has_hof_reason
               THEN 'WAITING_FOR_MANAGER'
           WHEN has_manager_reason
               THEN 'WAITING_FOR_HOF'
           ELSE 'PENDING_HOF_MANAGER'
       END
FROM (
    SELECT id,
           data,
           NULLIF(BTRIM(COALESCE(data->>'Reason (SCM)', '')), '') IS NOT NULL
               AS has_scm_reason,
           NULLIF(BTRIM(COALESCE(data->>'Reason (HOF)', '')), '') IS NOT NULL
               AS has_hof_reason,
           NULLIF(BTRIM(COALESCE(data->>'Reason (Manager)', '')), '') IS NOT NULL
               AS has_manager_reason
    FROM sheet_rows
    WHERE sheet_name = 'Response'
) AS reasons
WHERE has_scm_reason
  AND NOT COALESCE(
      data->>'Status' = ANY (ARRAY[
          'PENDING_HOF_MANAGER',
          'WAITING_FOR_MANAGER',
          'WAITING_FOR_HOF',
          'PENDING_HEAD_OFFICE',
          'PENDING_ADMIN',
          'APPROVED',
          'PENDING_SCM',
          'PENDING_CORRECTION'
      ]),
      FALSE
  );

-- Preview the records that qualify and the status each would receive.
SELECT row_id, current_status, derived_status
FROM discontinue_status_repairs
ORDER BY row_id;

SELECT count(*) AS records_to_repair
FROM discontinue_status_repairs;

-- Apply only the derived Status values.
WITH updated AS (
    UPDATE sheet_rows AS target
    SET data = jsonb_set(
        target.data,
        '{Status}',
        to_jsonb(repair.derived_status),
        TRUE
    )
    FROM discontinue_status_repairs AS repair
    WHERE target.id = repair.row_id
      AND target.sheet_name = 'Response'
      AND target.data->>'Status' IS DISTINCT FROM repair.derived_status
    RETURNING repair.current_status, repair.derived_status
)
SELECT current_status, derived_status, count(*) AS records_updated
FROM updated
GROUP BY current_status, derived_status
ORDER BY current_status, derived_status;

-- Change to COMMIT only after reviewing the preview and update counts.
ROLLBACK;
