"use client";
import {
  DISTRIBUTION_LANGUAGE_NAMES,
  type DistributionTextKey,
  distributionErrorText,
  distributionText,
} from "@satsang/distribution-contracts";
import {
  CTA_INTENTS,
  type CtaDefinition,
  type CtaIntent,
  type DistributionCapability,
  MISSION_OUTCOMES,
  type MissionOutcome,
  type OutreachCampaign,
} from "@satsang/distribution-domain";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { ActivationPanel } from "./activation-panel";
const API = "/distribution/api/outreach";
type Selection =
  | { kind: "campaign"; value: OutreachCampaign }
  | { kind: "cta"; value: CtaDefinition };
type Translator = (key: DistributionTextKey) => string;
function dateInput(iso: string) {
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function CampaignForm({
  value,
  busy,
  t,
  onSave,
}: {
  value: OutreachCampaign | undefined;
  busy: boolean;
  t: Translator;
  onSave: (data: unknown) => void;
}) {
  const [outcomes, setOutcomes] = useState<MissionOutcome[]>(
    value?.outcomes ?? ["PRACTICE_COMPLETED"],
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    onSave({
      name: f.get("name"),
      program: f.get("program"),
      goal: f.get("goal"),
      outcomes,
      startsAt: new Date(String(f.get("startsAt"))).toISOString(),
      endsAt: new Date(String(f.get("endsAt"))).toISOString(),
      budgetMicros: value?.budgetMicros ?? 0,
      ...(value ? { expectedRevision: value.revision } : {}),
    });
  };
  return (
    <form onSubmit={submit} aria-label={t("campaigns")}>
      <fieldset disabled={busy}>
        <label>
          {t("campaignName")}
          <input name="name" required maxLength={200} defaultValue={value?.name} />
        </label>
        <label>
          {t("program")}
          <input name="program" required maxLength={100} defaultValue={value?.program} />
        </label>
        <label>
          {t("goal")}
          <textarea name="goal" required rows={2} maxLength={1000} defaultValue={value?.goal} />
        </label>
        <fieldset style={{ marginBottom: 20 }}>
          <legend
            style={{ color: "var(--kamala-deep)", fontSize: 13, fontWeight: 600, marginBottom: 8 }}
          >
            {t("outcomes")}
          </legend>
          <div className="actions wrap" style={{ marginTop: 0, gap: 8 }}>
            {MISSION_OUTCOMES.map((outcome) => (
              <button
                key={outcome}
                type="button"
                className={`button ${outcomes.includes(outcome) ? "primary" : ""}`}
                style={{ whiteSpace: "normal", textAlign: "left" }}
                aria-pressed={outcomes.includes(outcome)}
                onClick={() =>
                  setOutcomes((current) =>
                    current.includes(outcome)
                      ? current.filter((item) => item !== outcome)
                      : [...current, outcome],
                  )
                }
              >
                {t(outcome)}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="fields">
          <label>
            {t("startsAt")}
            <input
              name="startsAt"
              type="datetime-local"
              required
              defaultValue={dateInput(value?.startsAt ?? new Date().toISOString())}
            />
          </label>
          <label>
            {t("endsAt")}
            <input
              name="endsAt"
              type="datetime-local"
              required
              defaultValue={dateInput(
                value?.endsAt ?? new Date(Date.now() + 7 * 86400000).toISOString(),
              )}
            />
          </label>
        </div>
        <button className="button primary" type="submit" disabled={busy || !outcomes.length}>
          {t("save")}
        </button>
      </fieldset>
    </form>
  );
}
function CtaForm({
  value,
  busy,
  t,
  onSave,
}: {
  value: CtaDefinition | undefined;
  busy: boolean;
  t: Translator;
  onSave: (data: unknown) => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    onSave({
      intent: f.get("intent") as CtaIntent,
      copy: f.get("copy"),
      language: f.get("language"),
      destination: { path: f.get("destination"), requiresIdentity: true },
      fallback: { path: f.get("fallback"), requiresIdentity: true },
      ...(value ? { expectedRevision: value.revision } : {}),
    });
  };
  return (
    <form onSubmit={submit} aria-label={t("ctas")}>
      <fieldset disabled={busy}>
        <label>
          {t("ctaCopy")}
          <input name="copy" required maxLength={120} defaultValue={value?.copy} />
        </label>
        <div className="fields">
          <label>
            {t("ctaIntent")}
            <select name="intent" defaultValue={value?.intent ?? "MEDITATE"}>
              {CTA_INTENTS.map((intent) => (
                <option key={intent} value={intent}>
                  {t(intent)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("language")}
            <select name="language" defaultValue={value?.language ?? "en"}>
              {Object.entries(DISTRIBUTION_LANGUAGE_NAMES).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          {t("destination")}
          <input
            name="destination"
            required
            maxLength={2000}
            placeholder="/practice/flute-meditation"
            defaultValue={value?.destination.path}
          />
        </label>
        <label>
          {t("fallback")}
          <input
            name="fallback"
            required
            maxLength={2000}
            placeholder="/practice/koti-parayana"
            defaultValue={value?.fallback.path}
          />
        </label>
        <button className="button primary" type="submit" disabled={busy}>
          {t("save")}
        </button>
      </fieldset>
    </form>
  );
}
export function OutreachPanel({
  locale,
  capabilities,
}: { locale: string; capabilities: DistributionCapability[] }) {
  const t = useCallback((key: DistributionTextKey) => distributionText(locale, key), [locale]);
  const [view, setView] = useState<"campaign" | "cta">("campaign");
  const [campaigns, setCampaigns] = useState<OutreachCampaign[]>([]);
  const [ctas, setCtas] = useState<CtaDefinition[]>([]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [history, setHistory] = useState<Array<OutreachCampaign | CtaDefinition>>([]);
  const canManage = capabilities.includes("campaigns.manage");
  const canReview = capabilities.includes("content.review");
  const canStop = canManage || capabilities.includes("operations.manage");
  const load = useCallback(async (offset = 0) => {
    const response = await fetch(`${API}?offset=${offset}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "unavailable");
    setCampaigns((current) => (offset ? [...current, ...data.campaigns] : data.campaigns));
    setCtas((current) => (offset ? [...current, ...data.ctas] : data.ctas));
    setNextOffset(data.nextOffset);
    setLoading(false);
  }, []);
  useEffect(() => {
    void load().catch((reason) => {
      setError(reason instanceof Error ? reason.message : "unavailable");
      setLoading(false);
    });
  }, [load]);
  async function perform(kind: "campaign" | "cta", body: unknown, action?: string) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const response = await fetch(
        action && selected ? `${API}/${kind}/${selected.value.id}/${action}` : `${API}/${kind}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409 && selected) {
          const latest = await fetch(`${API}/${kind}/${selected.value.id}`, { cache: "no-store" });
          if (latest.ok) {
            const update = await latest.json();
            setSelected(
              kind === "campaign" ? { kind, value: update.campaign } : { kind, value: update.cta },
            );
          }
        }
        throw new Error(data.error ?? "unavailable");
      }
      setSelected(kind === "campaign" ? { kind, value: data.campaign } : { kind, value: data.cta });
      setAdding(false);
      setEditing(false);
      setConfirming(false);
      setHistory([]);
      setSaved(true);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "unavailable");
    } finally {
      setBusy(false);
    }
  }
  function reset() {
    setSelected(null);
    setAdding(false);
    setEditing(false);
    setConfirming(false);
    setHistory([]);
    setSaved(false);
    setError("");
  }
  async function loadHistory() {
    if (!selected) return;
    try {
      const response = await fetch(`${API}/${selected.kind}/${selected.value.id}`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "unavailable");
      setHistory(data.history);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "unavailable");
    }
  }
  const status = (item: OutreachCampaign | CtaDefinition) =>
    "status" in item ? item.status : item.approval ? "APPROVED" : "DRAFT";
  if (
    !["campaigns.manage", "content.review", "operations.manage"].some((cap) =>
      capabilities.includes(cap as DistributionCapability),
    )
  )
    return null;
  return (
    <section aria-label={t("campaigns")}>
      <p className="workspace-intro">
        Campaigns group outreach around a program or initiative. Invitations are links that invite
        viewers to a practice, room or activity. These tools are optional; use Start New Curation to
        import a video or playlist and create channel content.
      </p>
      <div className="library-tools">
        <nav className="tabs" aria-label={t("campaigns")}>
          <button
            type="button"
            aria-current={view === "campaign" ? "page" : undefined}
            onClick={() => {
              reset();
              setView("campaign");
            }}
          >
            {t("campaigns")}
          </button>
          <button
            type="button"
            aria-current={view === "cta" ? "page" : undefined}
            onClick={() => {
              reset();
              setView("cta");
            }}
          >
            {t("ctas")}
          </button>
        </nav>
        {selected || adding ? (
          <button type="button" className="button" onClick={reset}>
            {t("back")}
          </button>
        ) : (
          canManage && (
            <button
              type="button"
              className="button primary"
              onClick={() => {
                reset();
                setAdding(true);
              }}
            >
              {t(view === "campaign" ? "createCampaign" : "createCta")}
            </button>
          )
        )}
      </div>
      {error && (
        <div className="notice" role="alert">
          <span>{distributionErrorText(locale, error)}</span>
          <button
            type="button"
            style={{ minHeight: 44 }}
            onClick={() => {
              setError("");
              void load().catch(() => setError("unavailable"));
            }}
          >
            {t("retry")}
          </button>
        </div>
      )}
      {saved && <output style={{ display: "block", marginBottom: 16 }}>{t("saved")}</output>}
      {loading ? (
        <output>{t("loading")}</output>
      ) : adding || editing ? (
        <div className="panel editor">
          <h2>
            {t(
              view === "campaign"
                ? adding
                  ? "createCampaign"
                  : "edit"
                : adding
                  ? "createCta"
                  : "edit",
            )}
          </h2>
          {view === "campaign" ? (
            <CampaignForm
              key={selected?.value.revision ?? "new"}
              value={selected?.kind === "campaign" ? selected.value : undefined}
              busy={busy}
              t={t}
              onSave={(data) => void perform("campaign", data, editing ? "edit" : undefined)}
            />
          ) : (
            <CtaForm
              key={selected?.value.revision ?? "new"}
              value={selected?.kind === "cta" ? selected.value : undefined}
              busy={busy}
              t={t}
              onSave={(data) => void perform("cta", data, editing ? "edit" : undefined)}
            />
          )}
        </div>
      ) : selected ? (
        <div className="panel editor">
          <div className="preview-meta" style={{ marginTop: 0, marginBottom: 18 }}>
            <span className="badge">{t(status(selected.value))}</span>
            <span>
              {t("version")} {selected.value.revision}
            </span>
          </div>
          <h2 style={{ overflowWrap: "anywhere" }}>
            {selected.kind === "campaign" ? selected.value.name : selected.value.copy}
          </h2>
          {selected.kind === "campaign" ? (
            <>
              <p style={{ overflowWrap: "anywhere" }}>{selected.value.goal}</p>
              <p className="muted">{selected.value.program}</p>
              <div className="actions wrap" style={{ marginTop: 14 }}>
                {selected.value.outcomes.map((outcome) => (
                  <span className="badge" key={outcome}>
                    {t(outcome)}
                  </span>
                ))}
              </div>
              <div className="fields" style={{ marginTop: 20 }}>
                {[
                  ["startsAt", selected.value.startsAt],
                  ["endsAt", selected.value.endsAt],
                ].map(([key, value]) => (
                  <div key={key}>
                    <p className="muted">{t(key as "startsAt" | "endsAt")}</p>
                    <time dateTime={value}>{new Date(value ?? "").toLocaleString(locale)}</time>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <p>
                {t(selected.value.intent)} ·{" "}
                {DISTRIBUTION_LANGUAGE_NAMES[
                  selected.value.language as keyof typeof DISTRIBUTION_LANGUAGE_NAMES
                ] ?? selected.value.language}
              </p>
              <dl style={{ display: "grid", gap: 8, overflowWrap: "anywhere" }}>
                <dt className="muted">{t("destination")}</dt>
                <dd style={{ margin: 0 }}>{selected.value.destination.path}</dd>
                <dt className="muted">{t("fallback")}</dt>
                <dd style={{ margin: 0 }}>{selected.value.fallback.path}</dd>
              </dl>
            </>
          )}
          <div className="actions wrap">
            {canManage && status(selected.value) !== "STOPPED" && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => {
                  setEditing(true);
                  setSaved(false);
                  setConfirming(false);
                }}
              >
                {t(status(selected.value) === "PAUSED" ? "resumeForReview" : "edit")}
              </button>
            )}
            {canReview && status(selected.value) === "DRAFT" && (
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void perform(
                    selected.kind,
                    { expectedRevision: selected.value.revision },
                    "approve",
                  )
                }
              >
                {t("approve")}
              </button>
            )}
            {selected.kind === "campaign" && canStop && selected.value.status === "APPROVED" && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void perform("campaign", { expectedRevision: selected.value.revision }, "pause")
                }
              >
                {t("pause")}
              </button>
            )}
            {selected.kind === "campaign" && canStop && selected.value.status !== "STOPPED" && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                {t("stop")}
              </button>
            )}
          </div>
          {confirming && selected.kind === "campaign" && (
            <div className="confirm" role="alert">
              <strong>{t("confirmStop")}</strong>
              <div className="actions wrap">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  {t("cancel")}
                </button>
                <button
                  type="button"
                  className="button danger"
                  disabled={busy}
                  onClick={() =>
                    void perform("campaign", { expectedRevision: selected.value.revision }, "stop")
                  }
                >
                  {t("stop")}
                </button>
              </div>
            </div>
          )}
          {selected.kind === "campaign" && (
            <ActivationPanel
              key={`${selected.value.id}:${selected.value.revision}`}
              campaign={selected.value}
              ctas={ctas}
              locale={locale}
              capabilities={capabilities}
            />
          )}
          <details
            className="editor-details"
            onToggle={(event) => {
              if (event.currentTarget.open) void loadHistory();
            }}
          >
            <summary>{t("versionHistory")}</summary>
            {history.map((item) => (
              <p key={item.revision}>
                {t("version")} {item.revision} · {t(status(item))}
              </p>
            ))}
          </details>
        </div>
      ) : (
        <>
          {(view === "campaign" ? campaigns : ctas).length === 0 ? (
            <div className="empty">
              <p>{t(view === "campaign" ? "emptyCampaigns" : "emptyCtas")}</p>
            </div>
          ) : (
            <div className="library-grid">
              {(view === "campaign" ? campaigns : ctas).map((item) => (
                <button
                  type="button"
                  className="content-card"
                  style={{ minHeight: 120 }}
                  key={item.id}
                  onClick={() => {
                    setSelected(
                      "kind" in item
                        ? { kind: "campaign", value: item }
                        : { kind: "cta", value: item },
                    );
                    setHistory([]);
                    setSaved(false);
                  }}
                >
                  <div className="card-body">
                    <span className="badge">{t(status(item))}</span>
                    <h2 style={{ marginTop: 14 }}>{"name" in item ? item.name : item.copy}</h2>
                    <p>
                      {t("version")} {item.revision}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
          {nextOffset !== null && (
            <button
              type="button"
              className="button"
              style={{ marginTop: 20 }}
              onClick={() => void load(nextOffset).catch(() => setError("unavailable"))}
            >
              {t("showAll")}
            </button>
          )}
        </>
      )}
    </section>
  );
}
