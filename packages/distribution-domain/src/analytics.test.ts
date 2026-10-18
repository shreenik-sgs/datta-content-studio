import { describe, expect, it } from "vitest";
import {
  type AnalyticsEvent,
  aggregateAnalytics,
  analyticsMetric,
  validateAnalyticsEvent,
} from "./analytics";
let serial = 1;
const id = () => `00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`;
const campaignId = id();
const actor = (n: number) => n.toString(16).padStart(64, "0");
const time = (hour: number) => `2026-10-01T${String(hour).padStart(2, "0")}:00:00.000Z`;
function event(
  name: AnalyticsEvent["name"],
  who: number,
  hour = 12,
  participationId: string | null = null,
): AnalyticsEvent {
  return {
    version: 1,
    id: id(),
    name,
    actorKey: actor(who),
    occurredAt: time(hour),
    correlationId: id(),
    campaignId,
    activationId: null,
    contentId: null,
    ctaId: null,
    consentBasis: "explicit_consent",
    consentReceipt: id(),
    source: "operator_fixture",
    sourceEventId: id(),
    participationId,
  };
}
const options = {
  start: time(0),
  end: "2026-10-02T00:00:00.000Z",
  now: "2026-10-03T00:00:00.000Z",
  outcomes: ["PRACTICE_COMPLETED"],
};
function metric(events: AnalyticsEvent[], key: string, outcomes = options.outcomes) {
  const found = aggregateAnalytics(events, { ...options, outcomes }).metrics.find(
    (metric) => metric.key === key,
  );
  if (!found) throw new Error("MISSING_METRIC");
  return found;
}
function sessions(people: number, completed = people) {
  const events: AnalyticsEvent[] = [];
  for (let person = 1; person <= people; person++) {
    const participation = id();
    events.push(event("practice.started", person, 10, participation));
    if (person <= completed) events.push(event("practice.completed", person, 11, participation));
  }
  return events;
}
describe("governed R6 analytics definitions", () => {
  it("suppresses small counts and complements and labels absent evidence", () => {
    expect(analyticsMetric("a", "A", 0, 0).status).toBe("not_recorded");
    expect(analyticsMetric("a", "A", 9, null).status).toBe("suppressed");
    expect(analyticsMetric("a", "A", 10, 11).status).toBe("suppressed");
    expect(analyticsMetric("a", "A", 10, 20)).toMatchObject({
      numerator: 10,
      denominator: 20,
      rate: 0.5,
      status: "reported",
    });
    expect(() => analyticsMetric("a", "A", 2, 1)).toThrow("INVALID_ANALYTICS_TOTAL");
    expect(() => analyticsMetric("a", "A", 1, 1, 1)).toThrow("INVALID_ANALYTICS_TOTAL");
  });
  it("does not let many events from one actor satisfy a privacy cohort", () => {
    const events = sessions(20, 10).map((e) => ({ ...e, actorKey: actor(1) }));
    expect(metric(events, "practice_completion")).toMatchObject({
      status: "suppressed",
      numerator: null,
      denominator: null,
    });
  });
  it("suppresses a large numerator contributed by one actor and a large one-actor complement", () => {
    const numerator = sessions(20, 0);
    for (let n = 0; n < 10; n++) {
      const participation = id();
      numerator.push(
        event("practice.started", 1, 10, participation),
        event("practice.completed", 1, 11, participation),
      );
    }
    expect(metric(numerator, "practice_completion").status).toBe("suppressed");
    const complement = sessions(10);
    for (let n = 0; n < 10; n++) complement.push(event("practice.started", 1, 10, id()));
    expect(metric(complement, "practice_completion").status).toBe("suppressed");
  });
  it("reports qualified distinct-actor cohorts with a non-small complement", () => {
    expect(metric(sessions(20, 10), "practice_completion")).toMatchObject({
      numerator: 10,
      denominator: 20,
      rate: 0.5,
      status: "reported",
    });
  });
  it("rejects completion-before-start attribution independent of arrival order", () => {
    const events = sessions(10)
      .map((e) => (e.name === "practice.completed" ? { ...e, occurredAt: time(9) } : e))
      .reverse();
    expect(metric(events, "practice_completion")).toMatchObject({
      numerator: 0,
      denominator: 10,
      rate: 0,
    });
    expect(aggregateAnalytics(events, options).unmatchedCompletions).toBe(10);
    expect(metric(sessions(10).reverse(), "practice_completion").rate).toBe(1);
  });
  it("reconciles late voids outside the display window and deduplicates participation", () => {
    const events = sessions(10);
    const late = events
      .filter((e) => e.name === "practice.completed")
      .map((e) => ({
        ...event("practice.voided", Number.parseInt(e.actorKey, 16), 12, e.participationId),
        occurredAt: "2026-10-02T12:00:00.000Z",
      }));
    expect(metric([...events, ...late], "practice_completion")).toMatchObject({
      numerator: 0,
      denominator: 10,
      rate: 0,
    });
    const repeated = events
      .filter((e) => e.name === "practice.completed")
      .map((e) => ({ ...e, id: id(), sourceEventId: id() }));
    expect(metric([...events, ...repeated], "practice_completion").numerator).toBe(10);
  });
  it("requires share-before-referral chronology and enough distinct sharing actors", () => {
    const shares = Array.from({ length: 20 }, (_, n) => event("advocacy.shared", n + 1, 10, id()));
    const outcomes = shares
      .slice(0, 10)
      .map((e) =>
        event(
          "advocacy.referred_outcome",
          100 + Number.parseInt(e.actorKey, 16),
          11,
          e.participationId,
        ),
      );
    expect(metric([...shares, ...outcomes], "advocacy_yield")).toMatchObject({
      numerator: 10,
      denominator: 20,
      rate: 0.5,
    });
    expect(
      metric([...shares, ...outcomes.map((e) => ({ ...e, occurredAt: time(9) }))], "advocacy_yield")
        .numerator,
    ).toBe(0);
    expect(
      metric([...shares.map((e) => ({ ...e, actorKey: actor(1) })), ...outcomes], "advocacy_yield")
        .status,
    ).toBe("suppressed");
  });
  it("excludes ambiguous ownership of a referral participation ID", () => {
    const sharedId = id();
    const events = [
      event("advocacy.shared", 1, 10, sharedId),
      event("advocacy.shared", 2, 10, sharedId),
      event("advocacy.referred_outcome", 3, 11, sharedId),
    ];
    expect(metric(events, "advocacy_yield").status).toBe("not_recorded");
  });
  it("uses the actual Seva campaign outcome and leaves unsupported outcomes unreported", () => {
    const visits = Array.from({ length: 20 }, (_, n) => event("tracked_link.opened", n + 1, 10));
    const outcomes = Array.from({ length: 10 }, (_, n) => event("seva.action", n + 1, 11));
    expect(
      metric([...visits, ...outcomes], "meaningful_action_rate", ["SEVA_DISCOVERED"]),
    ).toMatchObject({ numerator: 10, denominator: 20, rate: 0.5 });
    for (const outcome of ["SANKALPA_JOINED", "RETURNED", "REFERRED_PARTICIPATION"]) {
      expect(metric([...visits, ...outcomes], "meaningful_action_rate", [outcome]).status).toBe(
        "not_recorded",
      );
    }
  });
  it("does not attribute relationships and outcomes that precede the tracked visit", () => {
    const visits = Array.from({ length: 10 }, (_, n) => event("tracked_link.opened", n + 1, 12));
    const outcomes = Array.from({ length: 10 }, (_, n) => event("account.created", n + 1, 11));
    expect(metric([...visits, ...outcomes], "relationship_conversion").numerator).toBe(0);
  });
  it("refuses unknown properties, missing consent evidence, duplicate IDs and mixed campaigns", () => {
    const base = event("tracked_link.opened", 1);
    expect(() =>
      validateAnalyticsEvent(
        { ...base, email: "private@example.test" } as AnalyticsEvent,
        Date.parse(options.now),
      ),
    ).toThrow("INVALID_ANALYTICS_EVENT");
    expect(() =>
      validateAnalyticsEvent({ ...base, consentReceipt: "" }, Date.parse(options.now)),
    ).toThrow("INVALID_ANALYTICS_EVENT");
    expect(() => aggregateAnalytics([base, base], options)).toThrow("DUPLICATE_ANALYTICS_EVENT");
    expect(() =>
      aggregateAnalytics([base, { ...base, id: id(), campaignId: id() }], options),
    ).toThrow("INVALID_ANALYTICS_CAMPAIGN");
    expect(() => aggregateAnalytics([], { ...options, now: "unknown" })).toThrow(
      "INVALID_ANALYTICS_WINDOW",
    );
  });
});
