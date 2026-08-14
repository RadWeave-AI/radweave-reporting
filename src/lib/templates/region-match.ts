const JOINT_KEYWORDS = ["knee", "shoulder", "ankle", "hip", "wrist", "elbow", "hand", "foot"] as const;
export type Joint = (typeof JOINT_KEYWORDS)[number];

export function inferJoint(text: string): Joint | null {
  const lower = (text ?? "").toLowerCase();
  for (const joint of JOINT_KEYWORDS) {
    if (lower.includes(joint)) return joint;
  }
  return null;
}

// A CONFIRMED mismatch only: both sides name a specific, different joint. When either side
// is ambiguous (no joint keyword found), this returns false (not a mismatch) — an
// unidentifiable candidate is not assumed wrong, only a positively-different one is rejected.
export function isRegionMismatch(candidateText: string, queryText: string): boolean {
  const candidateJoint = inferJoint(candidateText);
  const queryJoint = inferJoint(queryText);
  if (!candidateJoint || !queryJoint) return false;
  return candidateJoint !== queryJoint;
}

