"use client";
import {
  type DistributionTextKey,
  distributionErrorText,
  distributionText,
} from "@satsang/distribution-contracts";
import type { PersistedActivation } from "@satsang/distribution-db";
import {
  ACTIVATION_PROMISES,
  type ActivationPackageInput,
  type CtaDefinition,
  type DistributionCapability,
  type OutreachCampaign,
  SOCIAL_PLACEMENTS,
} from "@satsang/distribution-domain";
import { type FormEvent, useCallback, useEffect, useState } from "react";
const API = "/distribution/api/outreach/activations";
function PackageFields({ value }: { value?: ActivationPackageInput | undefined }) {
  return (
    <>
      <label>
        Placement channel
        <select name="channel" defaultValue={value?.channel ?? "instagram"}>
          {SOCIAL_PLACEMENTS.map((channel) => (
            <option key={channel} value={channel}>
              {channel.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      <label>
        Caption / post copy
        <textarea name="copy" required rows={5} maxLength={12000} defaultValue={value?.copy} />
      </label>
      <label>
        What the CTA promises
        <select name="promise" defaultValue={value?.promise ?? "FULL_DISCOURSE"}>
          {ACTIVATION_PROMISES.map((promise) => (
            <option key={promise} value={promise}>
              {promise.replaceAll("_", " ").toLowerCase()}
            </option>
          ))}
        </select>
      </label>
      <label>
        Intended access
        <select name="intendedAccess" defaultValue={value?.intendedAccess ?? "AUTH_REQUIRED"}>
          <option value="PUBLIC">Public full experience</option>
          <option value="AUTH_REQUIRED">Sign-in required for the full experience</option>
        </select>
      </label>
    </>
  );
}
function packageFields(form: FormData) {
  return {
    channel: form.get("channel"),
    copy: form.get("copy"),
    promise: form.get("promise"),
    intendedAccess: form.get("intendedAccess"),
  };
}

export function ActivationPanel({
  campaign,
  ctas,
  locale,
  capabilities,
}: {
  campaign: OutreachCampaign;
  ctas: CtaDefinition[];
  locale: string;
  capabilities: DistributionCapability[];
}) {
  const t = (key: DistributionTextKey) => distributionText(locale, key);
  const [items, setItems] = useState<PersistedActivation[]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [packageEnabled, setPackageEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [options, setOptions] = useState<
    { id: string; revision: number; title: string; language: string }[]
  >([]);
  const canManage = capabilities.includes("campaigns.manage");
  const canReview = capabilities.includes("content.review");
  const canExport = capabilities.includes("content.publish");
  const canStop = canManage || capabilities.includes("operations.manage");
  const load = useCallback(async () => {
    const response = await fetch(`${API}?campaignId=${campaign.id}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw Error(data.error ?? "unavailable");
    setItems(data.activations);
    setPackageEnabled(data.packageEnabled === true);
  }, [campaign.id]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);
  async function perform(body: unknown, id?: string, action?: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(id ? `${API}/${id}/${action}` : API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error ?? "unavailable");
      setAdding(false);
      setEditing(null);
      setConfirm(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "unavailable");
      await load().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function begin() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API}?choices=1`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw Error(data.error ?? "unavailable");
      setOptions(data.artifacts);
      setPackageEnabled(data.packageEnabled === true);
      setAdding(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "unavailable");
    } finally {
      setBusy(false);
    }
  }
  const invitations = ctas.filter(
    (c) =>
      c.approval?.decision === "APPROVED" &&
      c.approval.revision === c.revision &&
      c.language !== "sa",
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const cta = invitations.find((c) => c.id === f.get("cta"));
    const artifact = options.find((a) => a.id === f.get("artifact"));
    if (!cta || !artifact) return;
    void perform({
      campaignId: campaign.id,
      expectedCampaignRevision: campaign.revision,
      ctaId: cta.id,
      expectedCtaRevision: cta.revision,
      artifactId: artifact.id,
      expectedArtifactRevision: artifact.revision,
      scheduledAt: new Date(Math.max(Date.now(), Date.parse(campaign.startsAt))).toISOString(),
      ...(packageEnabled ? { reviewPackage: packageFields(f) } : {}),
    });
  }
  return (
    <section
      aria-label={t("manualExport")}
      style={{ marginTop: 32, paddingTop: 24, borderTop: "1px solid var(--border)" }}
    >
      <h3>{t("manualExport")}</h3>
      <p className="muted">{t("manualSharingHint")}</p>
      {error && (
        <div role="alert" className="notice">
          {distributionErrorText(locale, error)}
        </div>
      )}
      {canManage && campaign.status === "APPROVED" && !adding && (
        <button type="button" className="button" disabled={busy} onClick={() => void begin()}>
          {t("prepareExport")}
        </button>
      )}
      {adding && (
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <label>
              {t("selectInvitation")}
              <select name="cta" required defaultValue="">
                <option value="" disabled>
                  {t("selectInvitation")}
                </option>
                {invitations.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.copy}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("selectVariant")}
              <select name="artifact" required defaultValue="">
                <option value="" disabled>
                  {t("selectVariant")}
                </option>
                {options.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title} · {a.language} · {t("version")} {a.revision}
                  </option>
                ))}
              </select>
            </label>
            {packageEnabled && <PackageFields />}
            <div className="actions wrap">
              <button
                type="submit"
                className="button primary"
                disabled={!invitations.length || !options.length}
              >
                {t("save")}
              </button>
              <button type="button" className="button" onClick={() => setAdding(false)}>
                {t("cancel")}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {!items.length && !adding && <p>{t("emptyActivations")}</p>}
      {items.map((a) => (
        <div
          key={a.id}
          style={{
            marginTop: 20,
            padding: 20,
            border: "1px solid var(--border)",
            borderRadius: 16,
          }}
        >
          <span className="badge">{t(a.status === "SCHEDULED" ? "APPROVED" : a.status)}</span>
          <h4 style={{ overflowWrap: "anywhere", marginBlock: 12 }}>{a.title}</h4>
          <p>{a.pinnedCta.copy}</p>
          <p className="muted" style={{ overflowWrap: "anywhere" }}>
            {a.pinnedCta.destination.path}
          </p>
          {a.reviewPackage && (
            <section aria-label="Full activation review">
              <p>
                <strong>{a.reviewPackage.channel.replaceAll("_", " ")}</strong> ·{" "}
                {a.reviewPackage.source.aspect} · {a.language}
              </p>
              <p className="muted">Review the media, copy, CTA and destination as one package.</p>
              {/* biome-ignore lint/a11y/useMediaCaption: An approved optional caption sidecar is shown when present. */}
              <video
                controls
                playsInline
                preload="metadata"
                style={{ maxWidth: "100%", maxHeight: 440 }}
                src={`/distribution/api/renders/${a.derivativeId}/media`}
              >
                {a.reviewPackage.source.hasCaptions && (
                  <track
                    kind="captions"
                    src={`/distribution/api/renders/${a.derivativeId}/captions`}
                    srcLang={a.language}
                    label="Approved captions"
                    default
                  />
                )}
              </video>
              <p>
                Source time: {(a.reviewPackage.source.startMs / 1000).toFixed(1)}–
                {(a.reviewPackage.source.endMs / 1000).toFixed(1)} seconds · Transcript revision{" "}
                {a.reviewPackage.source.transcriptRevision}
              </p>
              <p>
                {a.reviewPackage.source.nativeApproval
                  ? "Native-language boundaries and Teaching Integrity approval are bound to this media."
                  : "Source editorial and rights approval are bound to this media."}
              </p>
              <p style={{ whiteSpace: "pre-wrap" }}>{a.reviewPackage.copy}</p>
              <p>Promise: {a.reviewPackage.promise.replaceAll("_", " ").toLowerCase()}</p>
              <p>
                Access:{" "}
                {a.reviewPackage.destinationTest?.destination.accessMode === "PUBLIC"
                  ? "Public"
                  : a.reviewPackage.destinationTest?.destination.accessMode === "AUTH_REQUIRED"
                    ? "Sign-in required; exact destination restored"
                    : "Not tested"}
              </p>
              {a.reviewPackage.destinationTest && (
                <p className="muted">
                  Destination tested{" "}
                  {new Date(a.reviewPackage.destinationTest.checkedAt).toLocaleString(locale)}.
                  Approval checks the current destination again.
                </p>
              )}
              <a
                className="button"
                href={a.pinnedCta.destination.path}
                target="_blank"
                rel="noreferrer"
              >
                Open exact destination
              </a>
            </section>
          )}
          {editing === a.id && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform(
                  {
                    expectedRevision: a.revision,
                    reviewPackage: packageFields(new FormData(event.currentTarget)),
                  },
                  a.id,
                  "revise",
                );
              }}
            >
              <fieldset disabled={busy}>
                <PackageFields value={a.reviewPackage} />
                {a.status !== "DRAFT" && (
                  <p>
                    Saving creates a new draft and stops the earlier tracked link. The earlier
                    approval remains in history.
                  </p>
                )}
                <div className="actions wrap">
                  <button type="submit" className="button primary">
                    Save package revision
                  </button>
                  <button type="button" className="button" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </fieldset>
            </form>
          )}
          <div className="actions wrap">
            {packageEnabled && canManage && a.status !== "STOPPED" && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setEditing(a.id)}
              >
                {a.reviewPackage ? "Revise package" : "Add full package"}
              </button>
            )}
            {packageEnabled &&
              a.reviewPackage &&
              a.status === "DRAFT" &&
              (canManage || canReview) && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void perform({ expectedRevision: a.revision }, a.id, "validate-destination")
                  }
                >
                  Test Destination
                </button>
              )}
            {a.status === "DRAFT" && canReview && (
              <button
                type="button"
                className="button primary"
                disabled={
                  busy ||
                  (packageEnabled && !a.reviewPackage) ||
                  Boolean(a.reviewPackage && (!packageEnabled || !a.reviewPackage.destinationTest))
                }
                onClick={() => void perform({ expectedRevision: a.revision }, a.id, "approve")}
              >
                {t("approve")}
              </button>
            )}
            {a.status === "APPROVED" && (
              <>
                <a
                  className="button"
                  href={a.reviewPackage ? `/s/${a.token}` : `/outreach/${a.token}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("trackedInvitation")}
                </a>
                {canExport && (
                  <a className="button primary" href={`${API}/${a.id}/export`}>
                    {t("downloadPackage")}
                  </a>
                )}
              </>
            )}
            {a.status !== "STOPPED" && canStop && (
              <button type="button" className="button" onClick={() => setConfirm(a.id)}>
                {t("stop")}
              </button>
            )}
          </div>
          {confirm === a.id && (
            <div className="confirm" role="alert">
              <strong>{t("confirmStopActivation")}</strong>
              <div className="actions wrap">
                <button type="button" className="button" onClick={() => setConfirm(null)}>
                  {t("cancel")}
                </button>
                <button
                  type="button"
                  className="button danger"
                  disabled={busy}
                  onClick={() => void perform({ expectedRevision: a.revision }, a.id, "stop")}
                >
                  {t("stop")}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
