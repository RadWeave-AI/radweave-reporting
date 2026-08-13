/**
 * Request parsing and generic (non-clinical) validation.
 *
 * Two policies are promoted here from the website's Desktop bridge, where they
 * were treated as a Desktop quirk. For a service that will face hospital
 * customers they are the baseline:
 *
 *  1. Strict field ALLOWLIST — an unanticipated field cannot slip through.
 *  2. Explicit PHI DENYLIST checked first, so a caller sending a patient
 *     identifier gets an unambiguous rejection naming the field rather than a
 *     generic "unexpected field".
 *
 * Nothing here inspects clinical meaning; that belongs to the workflow modules
 * copied in during the later extraction mission.
 */

import { ServiceError } from "../http/errors.ts";
import type { WorkflowName } from "./types.ts";

/** Accepted by every workflow. */
const COMMON_FIELDS = [
  "modality",
  "body_region",
  "indication",
  "findings",
  "field_strength",
  "study_type",
  "laterality",
  "age",
  "sex",
  "model",
  "report_header",
  "opinion_hints",
  "residual_opinion_hints",
  "preserve_findings_order",
  "template_edits",
] as const;

const WORKFLOW_FIELDS: Record<WorkflowName, readonly string[]> = {
  checklist: [],
  quick: [],
  comparison: [
    "prior_date",
    "prior_opinion",
    "comparison_blocks",
    "annotated_findings",
    "new_findings",
    "stationary_phrasing",
    "new_phrasing",
  ],
  "my-template": [
    "user_template_text",
    "user_template_conclusion",
    "user_template_title",
    "use_reporting_style_profile",
  ],
  "template-guided": ["selected_template_id"],
};

const REQUIRED_FIELDS: Record<WorkflowName, readonly string[]> = {
  checklist: ["modality", "body_region", "findings"],
  quick: ["modality", "body_region", "findings"],
  comparison: ["modality", "body_region", "prior_date"],
  "my-template": ["modality", "body_region", "user_template_text"],
  "template-guided": ["modality", "body_region", "findings", "selected_template_id"],
};

/**
 * Never acceptable on any reporting endpoint, in any workflow. Checked before
 * the allowlist so the rejection names the offending field explicitly.
 */
export const PROHIBITED_FIELDS = new Set([
  "patient_name",
  "patient_id",
  "accession_number",
  "study_instance_uid",
  "series_instance_uid",
  "sop_instance_uid",
  "dicom",
  "dicom_file",
  "images",
  "pixels",
  "pixel_data",
  "file_path",
  "path",
  "local_path",
  "storage_reference",
  // The service derives identity from the credential; a caller may never
  // assert whose report this is.
  "user_id",
  "org_id",
]);

export type ReportRequestBody = Record<string, unknown>;

export function allowedFieldsFor(workflow: WorkflowName): Set<string> {
  return new Set<string>([...COMMON_FIELDS, ...WORKFLOW_FIELDS[workflow]]);
}

/**
 * Throws ServiceError("validation-error") on the first policy violation.
 * Order matters: PHI first, then unknown fields, then required fields.
 */
export function validateReportRequest(
  workflow: WorkflowName,
  body: unknown,
): ReportRequestBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ServiceError("validation-error", "Request body must be a JSON object.");
  }

  const record = body as ReportRequestBody;
  const keys = Object.keys(record);

  const prohibited = keys.filter((key) => PROHIBITED_FIELDS.has(key));
  if (prohibited.length > 0) {
    throw new ServiceError(
      "validation-error",
      "Request contains fields that must never be sent to a report-generation endpoint.",
      { prohibited_fields: prohibited },
    );
  }

  const allowed = allowedFieldsFor(workflow);
  const unexpected = keys.filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new ServiceError("validation-error", "Request contains unexpected fields.", {
      unexpected_fields: unexpected,
    });
  }

  const missing = REQUIRED_FIELDS[workflow].filter((field) => {
    const value = record[field];
    return typeof value !== "string" ? value == null : value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new ServiceError("validation-error", "Request is missing required fields.", {
      missing_fields: missing,
    });
  }

  return record;
}
