import { PAIRED_ORGANS } from "@/lib/config/study_types";

export type Laterality = "Right" | "Left" | "Bilateral";

const PAIRED_STUDY_TYPES = new Set(
  PAIRED_ORGANS.map((value) => value.trim().toLowerCase())
);

export function normalizeLaterality(input: unknown): Laterality | null {
  if (typeof input !== "string") return null;

  const value = input.trim().toLowerCase();
  if (!value) return null;

  if (value === "rt" || value === "right" || value === "right side") return "Right";
  if (value === "lt" || value === "left" || value === "left side") return "Left";
  if (value === "bilateral" || value === "both" || value === "b/l") return "Bilateral";

  return null;
}

export function isPairedStudyType(studyType: unknown): boolean {
  if (typeof studyType !== "string") return false;
  return PAIRED_STUDY_TYPES.has(studyType.trim().toLowerCase());
}

