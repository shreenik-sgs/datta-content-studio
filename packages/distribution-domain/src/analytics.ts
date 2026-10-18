export const ANALYTICS_NAMES = [
  "tracked_link.opened",
  "practice.started",
  "practice.completed",
  "practice.voided",
  "satsang.joined",
  "seva.action",
  "account.created",
  "consent.granted",
  "advocacy.shared",
  "advocacy.referred_outcome",
] as const;
export type AnalyticsName = (typeof ANALYTICS_NAMES)[number];
export type AnalyticsEvent = {
  version: 1;
  id: string;
  name: AnalyticsName;
  occurredAt: string;
  correlationId: string;
  actorKey: string;
  campaignId: string;
  activationId: string | null;
  contentId: string | null;
  ctaId: string | null;
  consentBasis: "explicit_consent" | "approved_service_measurement";
  consentReceipt: string;
  source: "canonical_core" | "signed_link" | "operator_fixture";
  sourceEventId: string;
  participationId: string | null;
};
export const ANALYTICS_DEFINITIONS = [
  {
    key: "tracked_returns",
    version: 1,
    label: "Tracked returns",
    definition:
      "Distinct pseudonymous visitors with a tracked visit in the selected reporting window.",
  },
  {
    key: "meaningful_action_rate",
    version: 1,
    label: "Meaningful action rate",
    definition:
      "Tracked visitors with a verified campaign-defined outcome after a tracked visit / tracked visitors. Unadopted outcome definitions are not recorded.",
  },
  {
    key: "practice_completion",
    version: 1,
    label: "Practice completion",
    definition:
      "Distinct matched, verified and unvoided practice completions / distinct valid starts; actor and participation ID must match and the start must precede completion.",
  },
  {
    key: "relationship_conversion",
    version: 1,
    label: "Relationship conversion",
    definition:
      "Tracked visitors who create an account or grant selected consent after a tracked visit / tracked visitors.",
  },
  {
    key: "advocacy_yield",
    version: 1,
    label: "Advocacy yield",
    definition:
      "Approved shares followed by a verified referred outcome / approved shares, matched by participation ID with one unambiguous sharing actor.",
  },
] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validateAnalyticsEvent(event: AnalyticsEvent, now: number) {
  const allowed = [
    "version",
    "id",
    "name",
    "occurredAt",
    "correlationId",
    "actorKey",
    "campaignId",
    "activationId",
    "contentId",
    "ctaId",
    "consentBasis",
    "consentReceipt",
    "source",
    "sourceEventId",
    "participationId",
  ];
  if (
    !Number.isFinite(now) ||
    Object.keys(event).length !== allowed.length ||
    Object.keys(event).some((k) => !allowed.includes(k)) ||
    event.version !== 1 ||
    !ANALYTICS_NAMES.includes(event.name) ||
    !uuid.test(event.id) ||
    !uuid.test(event.correlationId) ||
    !uuid.test(event.campaignId) ||
    !uuid.test(event.consentReceipt) ||
    !uuid.test(event.sourceEventId) ||
    ![event.activationId, event.contentId, event.ctaId, event.participationId].every(
      (v) => v === null || uuid.test(v),
    ) ||
    !/^[a-f0-9]{64}$/.test(event.actorKey) ||
    !["explicit_consent", "approved_service_measurement"].includes(event.consentBasis) ||
    !["canonical_core", "signed_link", "operator_fixture"].includes(event.source) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      event.occurredAt,
    ) ||
    !Number.isFinite(Date.parse(event.occurredAt)) ||
    Date.parse(event.occurredAt) > now + 300000 ||
    ([
      "practice.started",
      "practice.completed",
      "practice.voided",
      "advocacy.shared",
      "advocacy.referred_outcome",
    ].includes(event.name) &&
      !event.participationId)
  )
    throw new Error("INVALID_ANALYTICS_EVENT");
}
export type AnalyticsMetric = {
  key: string;
  label: string;
  numerator: number | null;
  denominator: number | null;
  rate: number | null;
  status: "reported" | "suppressed" | "not_recorded";
};
type CohortSizes = { numerator: number; denominator: number | null; complement: number | null };
/** Both event counts and distinct contributing actors must meet privacy thresholds. */
export function analyticsMetric(
  key: string,
  label: string,
  numerator: number,
  denominator: number | null,
  threshold = 10,
  cohorts: CohortSizes = {
    numerator,
    denominator,
    complement: denominator === null ? null : denominator - numerator,
  },
): AnalyticsMetric {
  if (
    !Number.isSafeInteger(threshold) ||
    threshold < 10 ||
    !Number.isSafeInteger(numerator) ||
    numerator < 0 ||
    (denominator !== null &&
      (!Number.isSafeInteger(denominator) || denominator < 0 || numerator > denominator)) ||
    [cohorts.numerator, cohorts.denominator, cohorts.complement].some(
      (n) => n !== null && (!Number.isSafeInteger(n) || n < 0),
    )
  )
    throw new Error("INVALID_ANALYTICS_TOTAL");
  const missing = denominator === 0 || (denominator === null && numerator === 0);
  const tooSmall = (n: number | null) => n !== null && n > 0 && n < threshold;
  const hidden =
    denominator === null
      ? numerator < threshold || cohorts.numerator < threshold
      : denominator < threshold ||
        (cohorts.denominator ?? 0) < threshold ||
        tooSmall(numerator) ||
        tooSmall(denominator - numerator) ||
        (numerator > 0 && cohorts.numerator < threshold) ||
        (denominator > numerator && (cohorts.complement ?? 0) < threshold);
  return {
    key,
    label,
    numerator: missing || hidden ? null : numerator,
    denominator: missing || hidden ? null : denominator,
    rate: missing || hidden || denominator === null ? null : numerator / denominator,
    status: missing ? "not_recorded" : hidden ? "suppressed" : "reported",
  };
}
export type AnalyticsAggregate = {
  definitionVersion: 1;
  sourceEvents: number;
  metrics: AnalyticsMetric[];
  unmatchedCompletions: number;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
};
const actors = (events: readonly AnalyticsEvent[]) =>
  new Set(events.map((event) => event.actorKey)).size;
const key = (event: AnalyticsEvent) => `${event.actorKey}:${event.participationId}`;
function earliest(events: readonly AnalyticsEvent[], by: (event: AnalyticsEvent) => string) {
  const found = new Map<string, AnalyticsEvent>();
  for (const event of events) {
    const id = by(event);
    const held = found.get(id);
    if (!held || Date.parse(event.occurredAt) < Date.parse(held.occurredAt)) found.set(id, event);
  }
  return found;
}
/** Inputs are bounded by the repository. This never awards canonical participation. */
export function aggregateAnalytics(
  events: readonly AnalyticsEvent[],
  options: { start: string; end: string; now: string; outcomes: readonly string[] },
): AnalyticsAggregate {
  const start = Date.parse(options.start);
  const end = Date.parse(options.end);
  const now = Date.parse(options.now);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(now) ||
    start >= end ||
    end - start > 31 * 86400000 ||
    events.length > 10000
  )
    throw new Error("INVALID_ANALYTICS_WINDOW");
  const seen = new Set<string>();
  const campaigns = new Set<string>();
  for (const event of events) {
    validateAnalyticsEvent(event, now);
    if (seen.has(event.id)) throw new Error("DUPLICATE_ANALYTICS_EVENT");
    seen.add(event.id);
    campaigns.add(event.campaignId);
  }
  if (campaigns.size > 1) throw new Error("INVALID_ANALYTICS_CAMPAIGN");
  const inWindow = events.filter(
    (event) => Date.parse(event.occurredAt) >= start && Date.parse(event.occurredAt) < end,
  );
  const started = earliest(
    inWindow.filter((event) => event.name === "practice.started"),
    key,
  );
  const voided = new Set(events.filter((event) => event.name === "practice.voided").map(key));
  const matchingStart = (event: AnalyticsEvent) => {
    const began = started.get(key(event));
    return began !== undefined && Date.parse(began.occurredAt) <= Date.parse(event.occurredAt);
  };
  const validCompletions = inWindow.filter(
    (event) =>
      event.name === "practice.completed" && matchingStart(event) && !voided.has(key(event)),
  );
  const completed = earliest(validCompletions, key);
  const validCompletionIds = new Set(validCompletions.map((event) => event.id));
  const visitors = earliest(
    inWindow.filter((event) => event.name === "tracked_link.opened"),
    (event) => event.actorKey,
  );
  const afterVisit = (event: AnalyticsEvent) => {
    const visit = visitors.get(event.actorKey);
    return visit !== undefined && Date.parse(visit.occurredAt) <= Date.parse(event.occurredAt);
  };
  const supportedOutcomes = ["PRACTICE_COMPLETED", "SATSANG_JOINED", "SEVA_DISCOVERED"];
  const measurable =
    options.outcomes.length > 0 &&
    options.outcomes.every((outcome) => supportedOutcomes.includes(outcome));
  const meaningful = new Set(
    inWindow
      .filter(
        (event) =>
          afterVisit(event) &&
          ((event.name === "practice.completed" &&
            validCompletionIds.has(event.id) &&
            options.outcomes.includes("PRACTICE_COMPLETED")) ||
            (event.name === "satsang.joined" && options.outcomes.includes("SATSANG_JOINED")) ||
            (event.name === "seva.action" && options.outcomes.includes("SEVA_DISCOVERED"))),
      )
      .map((event) => event.actorKey),
  );
  const relationship = new Set(
    inWindow
      .filter(
        (event) => ["account.created", "consent.granted"].includes(event.name) && afterVisit(event),
      )
      .map((event) => event.actorKey),
  );
  const shareEvents = inWindow.filter((event) => event.name === "advocacy.shared");
  const ambiguousShares = new Set<string>();
  const shareOwners = new Map<string, string>();
  for (const event of shareEvents) {
    const id = event.participationId ?? "";
    if (shareOwners.has(id) && shareOwners.get(id) !== event.actorKey) ambiguousShares.add(id);
    shareOwners.set(id, event.actorKey);
  }
  const shares = earliest(
    shareEvents.filter((event) => !ambiguousShares.has(event.participationId ?? "")),
    (event) => event.participationId ?? "",
  );
  const referred = new Set(
    inWindow
      .filter((event) => {
        const share = shares.get(event.participationId ?? "");
        return (
          event.name === "advocacy.referred_outcome" &&
          share !== undefined &&
          Date.parse(share.occurredAt) <= Date.parse(event.occurredAt)
        );
      })
      .map((event) => event.participationId ?? ""),
  );
  const starts = [...started.values()];
  const completions = [...completed.values()];
  const allShares = [...shares.values()];
  const counts: [number, number | null, CohortSizes][] = [
    [visitors.size, null, { numerator: visitors.size, denominator: null, complement: null }],
    [
      meaningful.size,
      visitors.size,
      {
        numerator: meaningful.size,
        denominator: visitors.size,
        complement: visitors.size - meaningful.size,
      },
    ],
    [
      completed.size,
      started.size,
      {
        numerator: actors(completions),
        denominator: actors(starts),
        complement: actors(starts.filter((event) => !completed.has(key(event)))),
      },
    ],
    [
      relationship.size,
      visitors.size,
      {
        numerator: relationship.size,
        denominator: visitors.size,
        complement: visitors.size - relationship.size,
      },
    ],
    [
      referred.size,
      shares.size,
      {
        numerator: actors(allShares.filter((event) => referred.has(event.participationId ?? ""))),
        denominator: actors(allShares),
        complement: actors(allShares.filter((event) => !referred.has(event.participationId ?? ""))),
      },
    ],
  ];
  return {
    definitionVersion: 1,
    sourceEvents: events.length,
    metrics: ANALYTICS_DEFINITIONS.map((definition, index) => {
      const value = counts[index];
      if (!value) throw new Error("METRIC_DEFINITION_MISSING");
      if (definition.key === "meaningful_action_rate" && !measurable)
        return analyticsMetric(definition.key, definition.label, 0, 0);
      return analyticsMetric(definition.key, definition.label, value[0], value[1], 10, value[2]);
    }),
    unmatchedCompletions: inWindow.filter(
      (event) => event.name === "practice.completed" && !matchingStart(event),
    ).length,
    generatedAt: options.now,
    windowStart: options.start,
    windowEnd: options.end,
  };
}
