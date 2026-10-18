"use client";
import { ANALYTICS_DEFINITIONS, type AnalyticsMetric } from "@satsang/distribution-domain";
import { useCallback, useEffect, useRef, useState } from "react";

type Snapshot = {
  campaign_id: string;
  generated_at: string;
  stale: boolean;
  report: {
    metrics: AnalyticsMetric[];
    windowStart: string;
    windowEnd: string;
    definitionVersion: number;
  };
};
type Dashboard = {
  policy: { retention_days: number; approved_at: string } | null;
  campaigns: { id: string; name: string }[];
  snapshots: Snapshot[];
  providerSnapshots: {
    campaign_id: string;
    provider: string;
    metric: string;
    value: string;
    currency: string | null;
    definition_version: number;
    observed_at: string;
    retrieved_at: string;
  }[];
  health: { queued_renders: number; failed_renders: number; retention_alerts: number };
  asOf: string;
};
const API = "/distribution/api/analytics";
function date(value: string) {
  return new Date(value).toLocaleString();
}
function message(code: string) {
  const known: Record<string, string> = {
    ANALYTICS_POLICY_REQUIRED: "Approve a TEST retention policy before importing or reconciling.",
    IDEMPOTENCY_CONFLICT: "This request identifier has already been used with different data.",
    INVALID_ANALYTICS_WINDOW:
      "Choose a window within the approved retention period, no longer than 31 days.",
    ANALYTICS_RETENTION_WINDOW: "The import includes events outside the approved retention period.",
    ANALYTICS_PRODUCER_NOT_ADOPTED:
      "Only operator fixture imports are available in this rehearsal.",
    UPLOAD_TOO_LARGE: "Choose a JSON file smaller than 1 MB.",
    INVALID_REQUEST: "The file does not match the analytics command format.",
    ANALYTICS_REBUILD_LIMIT:
      "This window exceeds 10,000 events. Choose a shorter reporting window.",
  };
  return known[code] ?? "The request could not be completed. Refresh and try again.";
}
export function AnalyticsDashboard({ canManage, isTest }: { canManage: boolean; isTest: boolean }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [campaignId, setCampaignId] = useState("");
  const [days, setDays] = useState(7);
  const [retention, setRetention] = useState(30);
  const [approval, setApproval] = useState("");
  const policyRequest = useRef<string | null>(null);
  const load = useCallback(async () => {
    const response = await fetch(API, { cache: "no-store" });
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status)) setData(null);
      throw new Error("Analytics is unavailable for this session.");
    }
    setData(await response.json());
  }, []);
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [load]);
  const run = async (command: unknown) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const result = await response.json();
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status)) setData(null);
        throw new Error(message(result.error));
      }
      await load();
      setNotice("Saved. The report reflects the latest completed reconciliation.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request unavailable.");
    } finally {
      setBusy(false);
    }
  };
  const selected = campaignId || data?.campaigns[0]?.id || "";
  const snapshot = data?.snapshots.find((item) => item.campaign_id === selected);
  return (
    <main className="shell analytics-page" aria-busy={busy}>
      <header className="topbar">
        <a className="brand" href="/distribution">
          SGS Distribution Hub
        </a>
        <span className="stage">{isTest ? "TEST rehearsal" : "Analytics"}</span>
      </header>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Mission outcomes</p>
          <h1>Analytics</h1>
        </div>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => {
            setError("");
            void load().catch((e: Error) => setError(e.message));
          }}
        >
          Refresh
        </button>
      </div>
      <p>
        Understand which invitations lead to meaningful participation. Values come from approved
        reporting definitions; small groups stay private.
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && <output className="notice">{notice}</output>}
      {data ? (
        <>
          <section className="panel">
            <h2>Reporting window</h2>
            <label>
              Campaign
              <select
                aria-label="Campaign"
                value={selected}
                onChange={(e) => setCampaignId(e.target.value)}
              >
                {!data.campaigns.length && <option value="">No approved campaigns</option>}
                {data.campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {canManage && (
              <div className="actions">
                <label>
                  Days to include
                  <select
                    aria-label="Days to include"
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                  >
                    {[1, 7, 14, 30]
                      .filter((n) => n <= (data.policy?.retention_days ?? 30))
                      .map((n) => (
                        <option key={n} value={n}>
                          {n} days
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="button primary"
                  disabled={busy || !selected || !data.policy}
                  onClick={() => {
                    void run({
                      action: "reconcile_recent",
                      campaignId: selected,
                      days,
                    });
                  }}
                >
                  Reconcile report
                </button>
              </div>
            )}
            {snapshot ? (
              <>
                <p>
                  Recorded {date(snapshot.generated_at)} · definition v
                  {snapshot.report.definitionVersion}
                </p>
                <p>
                  {date(snapshot.report.windowStart)} – {date(snapshot.report.windowEnd)}
                </p>
                {snapshot.stale && (
                  <output className="notice">
                    New source events are waiting for reconciliation.
                  </output>
                )}
                <div className="analytics-grid">
                  {snapshot.report.metrics.map((metric) => (
                    <article className="panel" key={metric.key}>
                      <h3>{metric.label}</h3>
                      <p className="metric-value">
                        {metric.status === "suppressed"
                          ? "Private"
                          : metric.status === "not_recorded"
                            ? "Not recorded"
                            : metric.rate === null
                              ? metric.numerator
                              : `${(metric.rate * 100).toFixed(1)}%`}
                      </p>
                      {metric.status === "reported" && metric.denominator !== null && (
                        <p>
                          {metric.numerator} / {metric.denominator}
                        </p>
                      )}
                      <p>{ANALYTICS_DEFINITIONS.find((d) => d.key === metric.key)?.definition}</p>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <p>No reconciled report yet. An approved campaign and eligible events are needed.</p>
            )}
          </section>
          <section className="panel">
            <h2>Channel observations</h2>
            <p>Provider values keep their own definitions and observation times.</p>
            {data.providerSnapshots
              .filter((item) => item.campaign_id === selected)
              .map((item) => (
                <p key={`${item.provider}:${item.metric}:${item.currency}`}>
                  {item.provider} · {item.metric}: {item.value}
                  {item.currency ? ` ${item.currency} (millionths)` : ""} · definition v
                  {item.definition_version} · observed {date(item.observed_at)} · retrieved{" "}
                  {date(item.retrieved_at)}
                </p>
              ))}
            {!data.providerSnapshots.some((item) => item.campaign_id === selected) && (
              <p>No channel observations recorded.</p>
            )}
          </section>
          <section className="panel">
            <h2>Operations</h2>
            <p>
              {data.health.queued_renders} renders queued · {data.health.failed_renders} failed ·{" "}
              {data.health.retention_alerts} retention alerts
            </p>
            <p>
              {data.policy
                ? `Approved TEST raw-event retention: ${data.policy.retention_days} days.`
                : "A TEST retention policy has not been approved."}{" "}
              Updated {date(data.asOf)}.
            </p>
          </section>
          {canManage && isTest && (
            <section className="panel">
              <h2>TEST data rehearsal</h2>
              <p>
                Import synthetic, consent-scoped fixture events only. Live collection remains
                closed.
              </p>
              {!data.policy && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    policyRequest.current ??= crypto.randomUUID();
                    void run({
                      action: "approve_policy",
                      requestId: policyRequest.current,
                      retentionDays: retention,
                      approvalReference: approval,
                    });
                  }}
                >
                  <label>
                    Retention days
                    <input
                      required
                      type="number"
                      min={7}
                      max={90}
                      value={retention}
                      onChange={(e) => {
                        setRetention(Number(e.target.value));
                        policyRequest.current = null;
                      }}
                    />
                  </label>
                  <label>
                    Approval reference UUID
                    <input
                      required
                      value={approval}
                      pattern="[0-9a-fA-F-]{36}"
                      onChange={(e) => {
                        setApproval(e.target.value);
                        policyRequest.current = null;
                      }}
                    />
                  </label>
                  <button type="submit" className="button" disabled={busy}>
                    Approve TEST policy
                  </button>
                </form>
              )}
              <label>
                Import analytics command (JSON, up to 1 MB)
                <input
                  aria-label="Import analytics command"
                  type="file"
                  accept="application/json,.json"
                  disabled={busy || !data.policy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    if (file.size > 1024 * 1024) {
                      setError(message("UPLOAD_TOO_LARGE"));
                      return;
                    }
                    void file
                      .text()
                      .then((text) => {
                        let command: unknown;
                        try {
                          command = JSON.parse(text);
                        } catch {
                          setError(message("INVALID_REQUEST"));
                          return;
                        }
                        void run(command);
                      })
                      .catch(() => setError("The file could not be read."));
                  }}
                />
              </label>
            </section>
          )}
        </>
      ) : (
        !error && <output>Loading analytics…</output>
      )}
    </main>
  );
}
