"use client";
import {
  type DistributionCapability,
  LIVE_CURATION_ERRORS,
  type LiveCurationBroadcast,
  type LiveCurationChannel,
  type LiveCurationMonitor,
} from "@satsang/distribution-domain";
import { useCallback, useEffect, useState } from "react";
import { StudioPanel } from "../studio-panel";
const API = "/distribution/api/live-curation";
type State = {
  available: boolean;
  channelError: string | null;
  channels: LiveCurationChannel[];
  monitors: LiveCurationMonitor[];
  broadcasts: LiveCurationBroadcast[];
};
export function LiveCurationPanel({
  capabilities,
}: { capabilities: readonly DistributionCapability[] }) {
  const [state, setState] = useState<State | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [setting, setSetting] = useState(false);
  const curate = capabilities.includes("content.create");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(API, { cache: "no-store", ...(signal ? { signal } : {}) });
    if (!response.ok) throw Error("Unable to load live curation. Refresh to retry.");
    setState(await response.json());
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh(abort.signal);
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "Unable to load monitoring");
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, 5000);
    };
    void poll();
    const id = new URLSearchParams(window.location.search).get("broadcast");
    if (id) setSelected(id);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [refresh]);
  async function save(
    monitors: {
      settings:
        | LiveCurationMonitor
        | Omit<LiveCurationMonitor, "id" | "revision" | "checkedAt" | "error">;
      expectedRevision: number | null;
    }[],
  ) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          monitors: monitors.map(({ settings, expectedRevision }) => ({
            expectedRevision,
            settings: {
              channelId: settings.channelId,
              channelName: settings.channelName,
              enabled: settings.enabled,
              language: settings.language,
              rights: settings.rights,
            },
          })),
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw Error(
          (LIVE_CURATION_ERRORS[data.error] ??
            (data.error === "REVISION_CONFLICT"
              ? "Settings changed. Refresh and try again."
              : "Unable to save monitoring. Check the fields and service availability.")) +
            (data.saved?.length ? ` Already saved: ${data.saved.join(", ")}.` : ""),
        );
      setMessage(
        monitors.some((m) => m.settings.enabled)
          ? "Monitoring saved. Complete teachings will appear below for review. Nothing is posted automatically."
          : "Monitoring paused. Saved recordings and reviews are retained.",
      );
      setSetting(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save");
    } finally {
      await refresh().catch(() => undefined);
      setBusy(false);
    }
  }
  if (!state) return <output>{error || "Loading live curation…"}</output>;
  const broadcast = state.broadcasts.find((b) => b.id === selected);
  const capturing = (channelId: string) =>
    state.available &&
    state.monitors.some((m) => m.channelId === channelId && m.enabled && !m.error);
  if (broadcast) {
    return (
      <section className="panel">
        <button type="button" className="button" onClick={() => setSelected(null)}>
          Back to broadcasts
        </button>
        <h1>{broadcast.title}</h1>
        <p>
          {broadcast.status === "CAPTURING"
            ? capturing(broadcast.channelId)
              ? "Live capture continues while you review the ready Shorts."
              : "Live capture is paused. Your saved sections and reviews are retained."
            : broadcast.status === "ENDED"
              ? "Broadcast capture ended. Review the complete teachings selected from the saved sections."
              : (LIVE_CURATION_ERRORS[broadcast.error ?? ""] ??
                "Capture needs attention. Saved sections are retained.")}
        </p>
        {broadcast.windows.some((w) => w.packageId) ? (
          <StudioPanel
            capabilities={capabilities}
            onOpenSource={(id, packageId) => {
              window.location.href = `/distribution?view=studio&master=${encodeURIComponent(id)}${packageId ? `&package=${encodeURIComponent(packageId)}` : ""}`;
            }}
            bundle={{
              title: broadcast.title,
              masterIds: broadcast.windows.map((w) => w.masterId),
              packageIds: broadcast.windows.flatMap((w) => (w.packageId ? [w.packageId] : [])),
            }}
            onBackToBundle={() => setSelected(null)}
          />
        ) : (
          <output>
            Waiting for the first complete section. Initial analysis starts after about ten minutes
            of captured video.
          </output>
        )}
      </section>
    );
  }
  return (
    <>
      <section className="panel">
        <h1>Live curation</h1>
        <p>
          Choose the channels once. Each live program becomes one bundle of English-captioned
          YouTube Shorts, checked by AI and sent for your approval.
        </p>
        <p>
          First analysis starts after about ten minutes of captured video. Generation and review
          take additional time.
        </p>
        <details className="live-help">
          <summary>About live capture and missed footage</summary>
          <p>
            Capture begins from the available live window. Import the full recording afterward to
            recover earlier or missed footage.
          </p>
        </details>
        {!state.available && (
          <output>
            Live monitoring is not running in this environment. Your administrator needs to enable
            the capture worker before starting.
          </output>
        )}
        {state.channelError && <p role="alert">{state.channelError}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {message && <output>{message}</output>}
        {state.monitors.map((m) => (
          <div className="panel" key={m.id}>
            <strong>{m.channelName}</strong>
            <p>
              {m.enabled ? "Monitoring enabled" : "Paused"}
              {m.checkedAt
                ? ` · Last checked ${new Date(m.checkedAt).toLocaleString()}`
                : " · Awaiting the worker"}
            </p>
            {m.error && (
              <output>{LIVE_CURATION_ERRORS[m.error] ?? "Monitoring needs attention."}</output>
            )}
            {curate && m.enabled && (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() =>
                  void save([{ settings: { ...m, enabled: false }, expectedRevision: m.revision }])
                }
              >
                Pause
              </button>
            )}
          </div>
        ))}
        {curate && (
          <button className="button" type="button" onClick={() => setSetting(!setting)}>
            {setting
              ? "Hide setup"
              : state.monitors.length
                ? "Change monitoring"
                : "Set up monitoring"}
          </button>
        )}
        {curate && setting && (
          <form
            className="live-setup"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const chosen = data.getAll("channel").map(String);
              if (!chosen.length || chosen.length > 2) {
                setError("Select one or two channels.");
                return;
              }
              if (data.get("confirm") !== "on") {
                setError("Confirm that the stated permission covers these channels.");
                return;
              }
              void save([
                ...state.monitors
                  .filter((m) => m.enabled && !chosen.includes(m.channelId))
                  .map((m) => ({
                    expectedRevision: m.revision,
                    settings: { ...m, enabled: false },
                  })),
                ...chosen.map((channelId) => {
                  const channel = state.channels.find((c) => c.channelId === channelId);
                  if (!channel) throw Error("Unknown channel");
                  const prior = state.monitors.find((m) => m.channelId === channelId);
                  return {
                    expectedRevision: prior?.revision ?? null,
                    settings: {
                      channelId,
                      channelName: channel.name,
                      enabled: true,
                      language: String(data.get("language") ?? "te"),
                      rights: {
                        owner: String(data.get("owner") ?? ""),
                        authorizationBasis: String(data.get("basis") ?? ""),
                        privacyClass: "PUBLIC" as const,
                        channels: ["youtube" as const],
                        territories: ["WORLDWIDE"],
                        releaseAt: null,
                        expiresAt: null,
                      },
                    },
                  };
                }),
              ]);
            }}
          >
            <fieldset>
              <legend>Channels from Practices</legend>
              {state.channels
                .filter((c) => c.enabled)
                .map((channel, i) => (
                  <label className="online-import-checkbox" key={channel.channelId}>
                    <input
                      type="checkbox"
                      name="channel"
                      value={channel.channelId}
                      defaultChecked={
                        state.monitors.length
                          ? state.monitors.some(
                              (m) => m.channelId === channel.channelId && m.enabled,
                            )
                          : i < 2
                      }
                    />
                    {channel.name} {channel.handle}
                  </label>
                ))}
              {!state.channels.some((c) => c.enabled) && (
                <p>No channels are configured. Add them under Admin → YouTube Live first.</p>
              )}
            </fieldset>
            <label>
              Primary spoken language
              <select name="language" defaultValue={state.monitors[0]?.language ?? "te"}>
                <option value="te">Telugu</option>
                <option value="kn">Kannada</option>
                <option value="en">English</option>
                <option value="hi">Hindi</option>
                <option value="ta">Tamil</option>
                <option value="ml">Malayalam</option>
                <option value="sa">Sanskrit</option>
              </select>
            </label>
            <label>
              Rights holder
              <input
                name="owner"
                required
                defaultValue={
                  state.monitors[0]?.rights.owner ?? "Sri Ganapathy Sachchidananda Ashrama"
                }
                maxLength={200}
              />
            </label>
            <label>
              Authorization covering future broadcasts
              <textarea
                name="basis"
                required
                defaultValue={state.monitors[0]?.rights.authorizationBasis ?? ""}
                placeholder="Record the permission granted by the content owner."
                maxLength={2000}
              />
            </label>
            <label className="online-import-checkbox live-consent">
              <input name="confirm" type="checkbox" required />I confirm this permission covers
              capture, external AI processing and public worldwide YouTube curation of the selected
              channels’ future broadcasts. Each Short still needs human approval before posting.
            </label>
            <button
              type="submit"
              className="button primary"
              disabled={busy || !state.available || Boolean(state.channelError)}
            >
              {busy ? "Saving…" : "Start monitoring"}
            </button>
          </form>
        )}
      </section>
      <section className="panel">
        <h2>Broadcasts</h2>
        {!state.broadcasts.length && (
          <p>
            No broadcasts captured yet. Once monitoring is enabled, new live programs appear here as
            one bundle each.
          </p>
        )}
        {state.broadcasts.map((b) => (
          <article className="panel" key={b.id}>
            <h3>{b.title}</h3>
            <p>
              {b.status === "CAPTURING"
                ? capturing(b.channelId)
                  ? "Capturing live"
                  : "Capture paused"
                : b.status === "ENDED"
                  ? "Capture ended"
                  : "Needs attention"}{" "}
              · {Math.floor(b.capturedMs / 60000)} minutes saved · {b.windows.length} sections
            </p>
            {b.error && <p>{LIVE_CURATION_ERRORS[b.error] ?? "Capture needs attention."}</p>}
            <button type="button" className="button" onClick={() => setSelected(b.id)}>
              Open broadcast
            </button>
            <a
              href={`https://www.youtube.com/watch?v=${b.videoId}`}
              target="_blank"
              rel="noreferrer"
            >
              Watch original
            </a>
          </article>
        ))}
      </section>
    </>
  );
}
