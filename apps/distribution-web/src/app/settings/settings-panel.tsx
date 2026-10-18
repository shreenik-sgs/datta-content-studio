"use client";
import {
  SOCIAL_PLACEMENTS,
  STUDIO_CHANNELS,
  type StudioChannel,
  studioChannelLabel,
} from "@satsang/distribution-domain";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { studioMessage } from "../../lib/studio-model";
import { BufferChannelPicker } from "./buffer-channel-picker";

type Account = {
  id: string;
  label: string;
  isDefault: boolean;
  platform: Exclude<StudioChannel, "website">;
  providerAccountId: string;
  enabled: boolean;
  eligibilityVerified: boolean;
  hasToken: boolean;
  hasWebhookAppSecret: boolean;
  hasWebhookVerifyToken: boolean;
  blocker: string | null;
  defaults?: {
    youtube?: { privacy: string; madeForKids: boolean; isAiGenerated: boolean; categoryId: string };
    tiktok?: { automaticPostingVerified: boolean; isAiGenerated: boolean };
    pinterest?: { boardServiceId: string };
    reddit?: { userAgent: string };
    whatsapp?: {
      businessAccountId: string;
      templateName: string;
      languageCode: string;
      recipientMode: string;
    };
  };
};
type Settings = {
  visualPreference: string;
  appLinks: { web: string; ios?: string; android?: string };
  revision: string;
  maxMasterUploadMb: number;
  maxMasterUploadCapacityMb: number;
  isTest: boolean;
  writable: boolean;
  trustedMediaOrigins: string[];
  accounts: Account[];
  runtime: {
    generationEnabled: boolean;
    publishingEnabled: boolean;
    transcription: string;
    drafting: string;
  };
};
const API = "/distribution/api/settings";
export function CurationSettings() {
  const [value, setValue] = useState<Settings | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Exclude<StudioChannel, "website"> | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState(false);
  const connectionHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (selected) {
      connectionHeading.current?.focus();
      connectionHeading.current?.scrollIntoView?.({ block: "start" });
    }
  }, [selected]);
  useEffect(() => {
    async function refresh() {
      const r = await fetch(API, { cache: "no-store" });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      setValue(data);
    }
    void refresh().catch(() => setMessage("Unable to load settings. Refresh to retry."));
  }, []);
  async function save(command: Record<string, unknown>) {
    if (!value) return;
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...command, expectedRevision: value.revision }),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      setValue(data);
      setSelected(null);
      setDisconnect(false);
      setMessage(
        command.action === "visuals"
          ? "Visual preference saved. Future generation and regeneration will use it automatically."
          : command.action === "uploads"
            ? "Upload limit saved. It applies to new uploads; existing masters are unchanged."
            : "Settings saved. Stored credentials are never displayed. Connection validity has not been tested with the provider.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? studioMessage(e.message) : "Save failed.");
    } finally {
      setBusy(false);
    }
  }
  if (!value) return <output>{message || "Loading settings…"}</output>;
  const account = value.accounts.find((a) => a.id === selectedAccountId && a.platform === selected);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const f = new FormData(event.currentTarget);
    const text = (key: string) => String(f.get(key) ?? "");
    const check = (key: string) => f.get(key) === "on";
    const defaults =
      selected === "youtube"
        ? {
            youtube: {
              privacy: text("privacy"),
              madeForKids: check("madeForKids"),
              isAiGenerated: check("isAiGenerated"),
              categoryId: text("categoryId"),
            },
          }
        : selected === "tiktok"
          ? {
              tiktok: {
                automaticPostingVerified: check("automaticPostingVerified"),
                isAiGenerated: check("isAiGenerated"),
              },
            }
          : selected === "pinterest"
            ? { pinterest: { boardServiceId: text("boardServiceId") } }
            : selected === "reddit"
              ? { reddit: { userAgent: text("userAgent") } }
              : selected === "whatsapp"
                ? {
                    whatsapp: {
                      businessAccountId: text("businessAccountId"),
                      templateName: text("templateName"),
                      languageCode: text("languageCode"),
                      recipientMode: "opted_in",
                    },
                  }
                : {};
    void save({
      action: "account",
      account: {
        ...(account ? { id: account.id } : {}),
        label: text("label"),
        isDefault: account?.isDefault === true || check("isDefault"),
        platform: selected,
        providerAccountId: text("providerAccountId"),
        enabled: check("enabled"),
        eligibilityVerified: check("eligibilityVerified"),
        accessToken: text("accessToken"),
        ...(selected === "whatsapp"
          ? {
              webhookAppSecret: text("webhookAppSecret"),
              webhookVerifyToken: text("webhookVerifyToken"),
            }
          : {}),
        defaults,
      },
    });
  }
  return (
    <>
      {message && <output className="notice">{message}</output>}
      {value.isTest && (
        <p className="notice">
          Test workspace: connections saved here are separate from production. No live messages or
          social posts are sent.
        </p>
      )}
      {!value.writable && (
        <p className="notice">
          Secure settings storage is not provisioned. Your deployment administrator must configure
          the private channel settings file and encryption key before credentials can be saved.
        </p>
      )}
      <section className="panel">
        <h2>Curation</h2>
        <p>
          <a href="/distribution/live">Live channel monitoring</a> — channel permissions, capture
          status and generated broadcast bundles.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void save({
              action: "app-links",
              appLinks: {
                web: String(data.get("web") ?? "").trim(),
                ios: String(data.get("ios") ?? "").trim(),
                android: String(data.get("android") ?? "").trim(),
              },
            });
          }}
        >
          <fieldset disabled={busy || !value.writable}>
            <legend>Website &amp; app-download links</legend>
            <label>
              Website (fallback)
              <input
                key={value.appLinks.web}
                name="web"
                type="url"
                required
                maxLength={2048}
                defaultValue={value.appLinks.web}
              />
            </label>
            <label>
              iOS App Store
              <input
                key={value.appLinks.ios ?? ""}
                name="ios"
                type="url"
                maxLength={2048}
                defaultValue={value.appLinks.ios ?? ""}
                placeholder="Add after App Store approval"
              />
            </label>
            <label>
              Android Play Store
              <input
                key={value.appLinks.android ?? ""}
                name="android"
                type="url"
                maxLength={2048}
                defaultValue={value.appLinks.android ?? ""}
                placeholder="Add when the Play Store listing is ready"
              />
            </label>
            <p className="muted">
              The “SGS Datta Sannidhi” link in the Hub player uses the viewer’s device and falls
              back to the website when its store link is empty. New renders remember these links. No
              raw address is printed on the card. Downloaded MP4s have no clickable links; social
              channels require their supported link placement.
            </p>
            <button type="submit" className="button">
              Save website &amp; app links
            </button>
          </fieldset>
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save({
              action: "visuals",
              visualPreference: String(
                new FormData(event.currentTarget).get("visualPreference") ?? "",
              ),
            });
          }}
        >
          <fieldset disabled={busy || !value.writable}>
            <label>
              Default visual preference
              <textarea
                key={value.visualPreference}
                name="visualPreference"
                required
                maxLength={1000}
                rows={4}
                defaultValue={value.visualPreference}
              />
            </label>
            <p className="muted">
              Remembered for every new generation and regeneration in this workspace. Images must
              still match the spoken teaching and pass review. Existing approved files stay
              unchanged.
            </p>
            <button type="submit" className="button">
              Save visual preference
            </button>
            <details>
              <summary>Curation rules applied automatically</summary>
              <ul>
                <li>
                  Source-specific, sacred and serene imagery; nature where it clarifies the
                  teaching.
                </li>
                <li>
                  Original voice, complete thoughts and faithful English subtitles by default.
                </li>
                <li>
                  Protected faces and names, readable text, and time to understand each
                  illustration.
                </li>
                <li>
                  Direct speaker openings when suitable; varied app-logo closing cards with a
                  silent, caption-free finish.
                </li>
                <li>
                  Telegram images include an exact excerpt from reviewed copy and @sgsswamiji
                  attribution.
                </li>
                <li>
                  AI checks the images and finished files; the Content Approver makes the final
                  decision.
                </li>
              </ul>
            </details>
          </fieldset>
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save({
              action: "uploads",
              maxMasterUploadMb: Number(new FormData(event.currentTarget).get("maxMasterUploadMb")),
            });
          }}
        >
          <fieldset disabled={busy || !value.writable}>
            <label>
              Maximum master upload size (MB)
              <input
                key={value.maxMasterUploadMb}
                name="maxMasterUploadMb"
                type="number"
                min={1}
                max={value.maxMasterUploadCapacityMb}
                step={1}
                required
                defaultValue={value.maxMasterUploadMb}
              />
            </label>
            <p className="muted">
              Current server capacity: {value.maxMasterUploadCapacityMb} MB per file. This setting
              applies to new masters and replacement uploads.
            </p>
            <button type="submit" className="button">
              Save upload limit
            </button>
          </fieldset>
        </form>
        <p>
          Generation:{" "}
          {value.runtime.generationEnabled ? "Enabled on this server" : "Disabled on this server"} ·
          Transcription: {value.runtime.transcription} · Drafting: {value.runtime.drafting}
        </p>
        <p>
          AI credentials and the master service switch belong to this app’s server configuration.
          Set STUDIO_GEMINI_API_KEY and STUDIO_SARVAM_API_KEY in the Content Studio secret store.
          Credentials are never read from Datta Sannidhi.
        </p>
        <p className="muted">
          Hub-rendered files use a separately configured logo and fixed layouts; changes to Site
          branding do not automatically update generated content. Languages, captions and audience
          guidance are chosen in each master’s workspace. Curator and Approver duties stay separate.
        </p>
      </section>
      <section className="panel">
        <h2>Publishing connections</h2>
        <p>
          Server publishing: {value.runtime.publishingEnabled ? "Enabled" : "Disabled"}. Saving a
          token does not enable server publishing or prove the token works.
        </p>
        <p>
          For Buffer channels, connect the Ashrama account in Buffer first, then enter its API token
          and channel ID here. Enter provider tokens, never social account passwords.
        </p>
        <div className="library-grid">
          {STUDIO_CHANNELS.filter((c) => c !== "website").map((channel) => {
            const accounts = value.accounts.filter((v) => v.platform === channel);
            const a = accounts.find((v) => v.isDefault) ?? accounts[0];
            return (
              <button
                type="button"
                className="content-card"
                key={channel}
                onClick={() => {
                  setSelected(channel);
                  setSelectedAccountId(a?.id ?? null);
                  setDisconnect(false);
                  setMessage("");
                }}
              >
                <div className="card-body">
                  <h3>
                    {channel === "youtube" ? "YouTube & Shorts" : studioChannelLabel(channel)}
                  </h3>
                  <p>
                    {a
                      ? a.blocker
                        ? "Saved · setup required"
                        : "Configured · not live-tested"
                      : "Not configured"}
                  </p>
                  <p>
                    {accounts.length} saved account{accounts.length === 1 ? "" : "s"}
                    {a ? ` · Default: ${a.label}` : ""}
                  </p>
                  <span>Manage accounts →</span>
                </div>
              </button>
            );
          })}
          <article className="content-card">
            <div className="card-body">
              <h3>Ashrama website</h3>
              <p>Internal approval workflow · no external credentials</p>
              <a href="/distribution">Open curation workspace →</a>
            </div>
          </article>
          {SOCIAL_PLACEMENTS.filter(
            (channel) =>
              channel !== "youtube_shorts" &&
              !STUDIO_CHANNELS.some((supported) => supported === channel),
          ).map((channel) => (
            <article className="content-card" key={channel}>
              <div className="card-body">
                <h3>{channel.charAt(0).toUpperCase() + channel.slice(1)}</h3>
                <p>Curation publishing connector not implemented</p>
                {channel === "email" ? (
                  <a href="/admin/email">Manage email service settings →</a>
                ) : (
                  <p className="muted">
                    Credentials cannot be connected until this integration is available.
                  </p>
                )}
              </div>
            </article>
          ))}
        </div>
        <p className="muted">
          YouTube Shorts use the connection above.{" "}
          <a href="/admin/youtube">Manage the separate native YouTube connection →</a>
        </p>
      </section>
      {selected && (
        <section className="panel" aria-label={`${studioChannelLabel(selected)} connection`}>
          <h2 ref={connectionHeading} tabIndex={-1}>
            {studioChannelLabel(selected)}
          </h2>
          <div className="actions wrap">
            <label>
              Saved account
              <select
                value={selectedAccountId ?? ""}
                onChange={(event) => {
                  setSelectedAccountId(event.target.value || null);
                  setDisconnect(false);
                  setMessage("");
                }}
              >
                <option value="">Add another account</option>
                {value.accounts
                  .filter((a) => a.platform === selected)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                      {a.isDefault ? " · Default" : ""}
                    </option>
                  ))}
              </select>
            </label>
            {account && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  setSelectedAccountId(null);
                  setDisconnect(false);
                }}
              >
                Add another account
              </button>
            )}
          </div>
          {selected === "youtube" && (
            <div className="panel">
              <h3>Connect a YouTube channel</h3>
              <ol>
                <li>
                  <a href="https://account.buffer.com/channels" target="_blank" rel="noreferrer">
                    Open Buffer channels ↗
                  </a>
                  , choose YouTube, and authorize the intended channel as its owner.
                </li>
                <li>
                  In Buffer, open Settings → API and create an API key. Enter it in the password
                  field below.
                </li>
                <li>
                  Click <strong>Find my YouTube channels</strong>, choose your channel, give it a
                  name and save. Select <strong>Default account</strong> for your usual destination.
                </li>
              </ol>
              <p>
                Buffer is the publishing service used by this Hub. Your Google password stays with
                Google. This connection is separate from the YouTube livestream connection.
              </p>
              <p>
                The approver can choose any saved account in step 6. The selected destination is
                locked when publishing is queued.
              </p>
            </div>
          )}
          {selected === "whatsapp" && (
            <p className="notice">
              For opted-in WhatsApp Business recipients, not Channels or groups. Branded message and
              image drafts are supported. Automatic delivery is not enabled: recipient consent and
              opt-out management, approved-template mapping, and verified delivery webhooks must be
              completed before sending. These credentials can be saved for setup, but cannot enable
              delivery.
            </p>
          )}
          {account?.blocker && <p>{studioMessage(account.blocker)}</p>}
          <form
            key={`${selected}-${selectedAccountId ?? "new"}-${value.revision}`}
            onSubmit={submit}
          >
            <fieldset disabled={busy || !value.writable}>
              <label>
                Account name
                <input
                  name="label"
                  required
                  maxLength={120}
                  defaultValue={account?.label ?? ""}
                  placeholder={
                    selected === "youtube" ? "e.g. @DattaSannidhi" : "Name the destination"
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  name="isDefault"
                  disabled={account?.isDefault === true}
                  defaultChecked={
                    account?.isDefault ?? !value.accounts.some((a) => a.platform === selected)
                  }
                />{" "}
                Default account
              </label>
              <label>
                {selected === "whatsapp"
                  ? "Phone number ID"
                  : selected === "telegram"
                    ? "Telegram channel ID or @name"
                    : selected === "reddit"
                      ? "Subreddit (without r/)"
                      : "Buffer channel ID"}
                <input
                  name="providerAccountId"
                  readOnly={Boolean(account)}
                  required
                  maxLength={160}
                  defaultValue={account?.providerAccountId ?? ""}
                />
              </label>
              <label>
                {selected === "whatsapp"
                  ? "WhatsApp Business access token"
                  : selected === "telegram"
                    ? "Telegram bot token"
                    : selected === "reddit"
                      ? "Reddit OAuth access token"
                      : "Buffer API token"}
                <input
                  name="accessToken"
                  type="password"
                  autoComplete="new-password"
                  required={!account?.hasToken}
                  maxLength={8192}
                  placeholder={
                    account?.hasToken ? "Stored — leave blank to keep" : "Not configured"
                  }
                />
              </label>
              {selected === "youtube" && !account && <BufferChannelPicker platform="youtube" />}
              {account && (
                <p>
                  To use a different channel ID, add another account. Existing publishing requests
                  keep this destination.
                </p>
              )}
              {selected === "youtube" && (
                <>
                  <label>
                    Privacy
                    <select
                      name="privacy"
                      defaultValue={account?.defaults?.youtube?.privacy ?? "private"}
                    >
                      <option>private</option>
                      <option>unlisted</option>
                      <option>public</option>
                    </select>
                  </label>
                  <label>
                    Category ID
                    <input
                      name="categoryId"
                      required
                      defaultValue={account?.defaults?.youtube?.categoryId ?? "27"}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      name="madeForKids"
                      defaultChecked={account?.defaults?.youtube?.madeForKids}
                    />{" "}
                    Made for kids
                  </label>
                </>
              )}
              {(selected === "youtube" || selected === "tiktok") && (
                <label>
                  <input
                    type="checkbox"
                    name="isAiGenerated"
                    defaultChecked={
                      account?.defaults?.youtube?.isAiGenerated ??
                      account?.defaults?.tiktok?.isAiGenerated
                    }
                  />{" "}
                  Declare synthetic or altered audiovisual media
                </label>
              )}
              {selected === "tiktok" && (
                <label>
                  <input
                    type="checkbox"
                    name="automaticPostingVerified"
                    defaultChecked={account?.defaults?.tiktok?.automaticPostingVerified}
                  />{" "}
                  Automatic posting eligibility verified
                </label>
              )}
              {selected === "pinterest" && (
                <label>
                  Pinterest board ID
                  <input
                    name="boardServiceId"
                    required
                    defaultValue={account?.defaults?.pinterest?.boardServiceId ?? ""}
                  />
                </label>
              )}
              {selected === "reddit" && (
                <label>
                  Reddit application user agent
                  <input
                    name="userAgent"
                    required
                    defaultValue={account?.defaults?.reddit?.userAgent ?? ""}
                  />
                </label>
              )}
              {selected === "whatsapp" && (
                <>
                  <label>
                    WhatsApp Business Account ID
                    <input
                      name="businessAccountId"
                      required
                      defaultValue={account?.defaults?.whatsapp?.businessAccountId ?? ""}
                    />
                  </label>
                  <label>
                    Approved template name
                    <input
                      name="templateName"
                      required
                      defaultValue={account?.defaults?.whatsapp?.templateName ?? ""}
                    />
                  </label>
                  <label>
                    Template language code
                    <input
                      name="languageCode"
                      required
                      placeholder="en_US"
                      defaultValue={account?.defaults?.whatsapp?.languageCode ?? ""}
                    />
                  </label>
                  <label>
                    Meta app secret (webhook signature verification)
                    <input
                      name="webhookAppSecret"
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        account?.hasWebhookAppSecret
                          ? "Stored — leave blank to keep"
                          : "Not configured"
                      }
                    />
                  </label>
                  <label>
                    Webhook verification token
                    <input
                      name="webhookVerifyToken"
                      type="password"
                      autoComplete="new-password"
                      placeholder={
                        account?.hasWebhookVerifyToken
                          ? "Stored — leave blank to keep"
                          : "Not configured"
                      }
                    />
                  </label>
                </>
              )}
              {selected !== "whatsapp" && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      name="eligibilityVerified"
                      defaultChecked={account?.eligibilityVerified}
                    />{" "}
                    I verified the destination and its automatic publishing permissions
                  </label>
                  <label>
                    <input type="checkbox" name="enabled" defaultChecked={account?.enabled} /> Allow
                    this connection when server publishing is enabled
                  </label>
                </>
              )}
              <button className="button primary" type="submit">
                Save connection
              </button>
            </fieldset>
          </form>
          <div className="actions wrap">
            <button className="button" type="button" onClick={() => setSelected(null)}>
              Close
            </button>
            {account && (
              <button
                className="button danger"
                type="button"
                disabled={busy || !value.writable}
                onClick={() => setDisconnect(true)}
              >
                Disconnect
              </button>
            )}
          </div>
          {disconnect && (
            <p>
              Remove this connection and its stored credentials?{" "}
              <button
                className="button danger"
                type="button"
                disabled={busy}
                onClick={() =>
                  void save({ action: "disconnect", platform: selected, accountId: account?.id })
                }
              >
                Confirm disconnect
              </button>{" "}
              <button className="button" onClick={() => setDisconnect(false)} type="button">
                Cancel
              </button>
            </p>
          )}
        </section>
      )}
      <details className="panel">
        <summary>Media delivery settings</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const raw = String(new FormData(e.currentTarget).get("origins") ?? "");
            void save({ action: "media", trustedMediaOrigins: raw.split(/\s+/).filter(Boolean) });
          }}
        >
          <p>
            Approved HTTPS media origins only, one per line. Public media hosting and signed URL
            configuration must also be provisioned on the server.
          </p>
          <label>
            Trusted media origins
            <textarea name="origins" rows={3} defaultValue={value.trustedMediaOrigins.join("\n")} />
          </label>
          <button className="button" disabled={busy || !value.writable} type="submit">
            Save media settings
          </button>
        </form>
      </details>
    </>
  );
}
