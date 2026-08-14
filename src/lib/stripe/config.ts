export const PLANS = {
  free: {
    name: "Free",
    price: 0,
    currency: "USD",
    priceId: null,
    reports: 10,
    features: [
      "10 AI credits per month",
      "Normal templates browsing",
      "Basic AI report trial",
      "1 free teaching case",
      "Basic anatomy links",
    ],
  },
  basic: {
    name: "Basic",
    price: 9,
    currency: "USD",
    priceId: process.env.NEXT_PUBLIC_STRIPE_BASIC_PRICE_ID ?? null,
    reports: 100,
    features: [
      "100 AI credits per month",
      "Full pathology AI report generation",
      "Formatted copy",
      "Download generated reports as Word",
      "Full normal template access",
      "Limited teaching case library access",
    ],
  },
  pro: {
    name: "Pro",
    price: 19,
    currency: "USD",
    priceId: process.env.NEXT_PUBLIC_STRIPE_PRO_PRICE_ID ?? null,
    reports: 300,
    features: [
      "300 AI credits per month",
      "Everything in Basic",
      "Differential diagnosis helper",
      "Full teaching case library access",
      "Saved teaching case attempts",
      "Personal performance dashboard",
      "Full pathology template library",
      "Template PDF viewing and text copy",
    ],
  },
  institution: {
    name: "Institution",
    price: 99,
    currency: "USD",
    priceId: process.env.NEXT_PUBLIC_STRIPE_INSTITUTION_PRICE_ID ?? null,
    reports: 2000,
    features: [
      "Everything in Pro",
      "Up to 10 users",
      "2000 shared AI credits per month",
      "Centralized billing",
      "Admin dashboard",
      "Team usage analytics",
      "Team progress tracking",
      "Priority support",
    ],
  },
} as const;

export type PlanKey = keyof typeof PLANS;

/**
 * Legacy website helper retained because the reporting copy imports PlanKey
 * from this module. The standalone service has no stripe/server module.
 */
export function priceIdToPlanKey(priceId: string): PlanKey {
  const map: Record<string, PlanKey> = {
    [process.env.STRIPE_BASIC_PRICE_ID       ?? ""]: "basic",
    [process.env.STRIPE_PRO_PRICE_ID         ?? ""]: "pro",
    [process.env.STRIPE_INSTITUTION_PRICE_ID ?? ""]: "institution",
  };
  return map[priceId] ?? "free";
}
