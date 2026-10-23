"use client";
import {
  type StudioChannel,
  studioChannelLabel,
  studioFileStatus,
  studioPublicationMatchesFile,
  studioWorkflow,
  unconfiguredStudioClosingChannels,
} from "@satsang/distribution-domain";
import { useState } from "react";
import { STUDIO_PUBLICATION_LABELS, type StudioDetail, studioMessage } from "../lib/studio-model";
import { StudioPostingCheck } from "./studio-posting-check";

/** Show delivery readiness before approval, and keep the next action above the files. */
export function StudioPublishing({
  detail,
  canPublish,
  canManage,
  busy,
  onPublish,
  onRefresh,
}: {
  detail: StudioDetail;
  canPublish: boolean;
  canManage: boolean;
  busy: boolean;
  onPublish: (accounts: Partial<Record<StudioChannel, string>>, outputIds: string[]) => void;
  onRefresh: () => void;
}) {
  const { package: value, readiness, publications } = detail;
  const [chosen, setChosen] = useState<Partial<Record<StudioChannel, string>>>({});
  const approvedFiles = value.outputs.filter((o) => studioFileStatus(value, o) === "APPROVED");
  const approved = approvedFiles.length > 0;
  const [selected, setSelected] = useState<string[]>([]);
  const included = approvedFiles.filter((o) => selected.includes(o.id));
  const blockers = [
    ...new Set(included.flatMap((o) => detail.outputBlockers?.[o.id] ?? detail.blockers)),
  ];
  const unconfiguredClosingChannels = unconfiguredStudioClosingChannels(included);
  const channels = [...new Set(included.map((output) => output.channel))];
  const current = publications.filter((p) =>
    included.some((o) => o.id === p.outputId && studioPublicationMatchesFile(value, o, p)),
  );
  const complete = studioWorkflow({ package: value, publications }).complete;
  const pending = current.some((p) => ["QUEUED", "RUNNING", "PROCESSING"].includes(p.status));
  const uncertain = current.some((p) => p.status === "UNCERTAIN");
  function destination(channel: StudioChannel) {
    const connection = readiness.channels.find((item) => item.channel === channel);
    const pinned = current.find(
      (p) => p.channel === channel && p.selectedAccountId,
    )?.selectedAccountId;
    const id =
      pinned ?? chosen[channel] ?? connection?.accounts?.find((account) => account.isDefault)?.id;
    const account = connection?.accounts?.find((account) => account.id === id);
    return { connection, account, id, pinned };
  }
  const configured = channels.every((channel) => {
    const { connection, account } = destination(channel);
    return connection?.accounts?.length ? account?.ready : connection?.ready;
  });
  const selectionValid = channels.every((channel) => {
    const { connection, account, id } = destination(channel);
    return id ? Boolean(account) && !account?.connectionPending : !connection?.accounts?.length;
  });
  const disabled =
    busy ||
    !canPublish ||
    !selectionValid ||
    !included.length ||
    unconfiguredClosingChannels.length > 0 ||
    blockers.length > 0 ||
    complete ||
    pending ||
    uncertain ||
    current.some((p) => ["PUBLISHED", "SIMULATED", "CANCELLED"].includes(p.status)) ||
    (!value.isTest && !configured);
  return (
    <section
      className="panel"
      id={`package-publishing-${value.id}`}
      tabIndex={-1}
      aria-label="Publishing"
      style={{ marginBlock: 16, scrollMarginTop: 100 }}
    >
      <h3>{approved ? "Step 6 · Publish approved content" : "Publishing after approval"}</h3>
      <p>
        {approved
          ? `Approval saved. ${approvedFiles.length} approved file${approvedFiles.length === 1 ? " is" : "s are"} locked for publishing. Select the files to post.`
          : "The generated files still need package approval. Approving the master permissions alone does not approve these files."}
      </p>
      {value.isTest ? (
        <p className="notice" style={{ display: "block" }}>
          <strong>Test workspace — no videos will be posted to YouTube or other channels.</strong>{" "}
          You can test the publishing workflow here. Real posting requires a live workspace with
          publishing enabled and its own verified channel connection; saving credentials here does
          not turn this test package into a live post.
        </p>
      ) : (
        <p>
          Approval does not post automatically. Use the publish button below to send the approved
          files.
        </p>
      )}
      {unconfiguredClosingChannels.length > 0 && (
        <p>
          Before publishing, configure the YouTube destination for{" "}
          {unconfiguredClosingChannels.join(", ")} and update its subscription description. The
          closing card must match the intended channel.
        </p>
      )}
      {approved && (
        <fieldset disabled={busy}>
          <legend>Files to post</legend>
          <label>
            <input
              type="checkbox"
              checked={
                approvedFiles.length > 0 && approvedFiles.every((o) => selected.includes(o.id))
              }
              onChange={(e) => setSelected(e.target.checked ? approvedFiles.map((o) => o.id) : [])}
            />{" "}
            Select all approved files
          </label>
          {approvedFiles.map((o) => (
            <label key={o.id} style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? [...selected, o.id] : selected.filter((id) => id !== o.id),
                  )
                }
              />{" "}
              {o.title}
            </label>
          ))}
        </fieldset>
      )}
      <ul>
        {channels.map((channel) => {
          const { connection, account, id, pinned } = destination(channel);
          const outputs = included.filter((output) => output.channel === channel);
          return (
            <li key={channel} style={{ marginBlock: 12 }}>
              <strong>
                {studioChannelLabel(channel)} · {outputs.length} file
                {outputs.length === 1 ? "" : "s"}
              </strong>
              {channel !== "website" && Boolean(connection?.accounts?.length || id) && (
                <label>
                  {studioChannelLabel(channel)} target account
                  <select
                    value={id ?? ""}
                    disabled={busy || !canPublish || Boolean(pinned)}
                    onChange={(event) =>
                      setChosen((previous) => ({ ...previous, [channel]: event.target.value }))
                    }
                  >
                    {!account && (
                      <option value={id ?? ""}>
                        {id ? "Selected account is no longer configured" : "Choose an account"}
                      </option>
                    )}
                    {connection?.accounts?.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                        {a.isDefault ? " · Default" : ""}
                        {a.connectionPending
                          ? " · Connection required"
                          : !value.isTest && !a.ready
                            ? " · Setup required"
                            : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {account?.channelUrl && (
                <p>
                  Destination:{" "}
                  <a href={account.channelUrl} target="_blank" rel="noreferrer">
                    {account.channelUrl}
                  </a>
                </p>
              )}
              {account?.connectionPending && (
                <p>
                  {account.label} is saved as a target. An Admin must connect this account in
                  Curation &amp; Publishing before it can be used for posting.
                </p>
              )}
              {account?.privacy && (
                <p>
                  YouTube visibility: <strong>{account.privacy}</strong>
                </p>
              )}
              {pinned && <p>This destination is locked to the saved publishing request.</p>}
              {id && !account && (
                <p>
                  Refresh the saved connections. This destination cannot be replaced automatically.
                </p>
              )}
              <p>
                {value.isTest
                  ? connection?.accountId
                    ? "A connection is saved for testing. External posting remains disabled."
                    : "No publishing account is saved in this test workspace. A simulation does not need one."
                  : (account?.ready ?? connection?.ready)
                    ? "Connection configured. The channel will confirm delivery when you publish."
                    : studioMessage(
                        account?.reason ?? connection?.reason ?? "CHANNEL_NOT_CONNECTED",
                      )}
              </p>
              {connection?.transport === "buffer" && !connection.accountId && (
                <p>
                  Connect the intended channel in Buffer, then save its channel ID and API token in
                  Curation &amp; Publishing.
                </p>
              )}
              {channel === "youtube" && id && account && !account.connectionPending && (
                <StudioPostingCheck
                  key={`${value.id}:${id}`}
                  packageId={value.id}
                  revision={value.revision}
                  accountId={id}
                  outputs={outputs}
                  publications={publications}
                />
              )}
              {current
                .filter((p) => outputs.some((output) => output.id === p.outputId))
                .map((p) => (
                  <p key={p.id}>
                    {outputs.find((output) => output.id === p.outputId)?.title}:{" "}
                    {STUDIO_PUBLICATION_LABELS[p.status]}
                    {p.error && <> — {studioMessage(p.error)}</>}
                    {p.remoteUrl && (
                      <>
                        {" "}
                        ·{" "}
                        <a href={p.remoteUrl} target="_blank" rel="noreferrer">
                          Open published content
                        </a>
                      </>
                    )}
                  </p>
                ))}
            </li>
          );
        })}
      </ul>
      {canManage ? (
        <a href="/distribution/settings" target="_blank" rel="noreferrer">
          Open Admin → Settings → Curation &amp; Publishing ↗
        </a>
      ) : (
        <p>
          Ask an Admin to check Admin → Settings → Curation &amp; Publishing. The Content Approver
          role alone cannot change channel credentials.
        </p>
      )}
      {approved && blockers.length > 0 && (
        <div aria-live="polite">
          <strong>Resolve before publishing:</strong>
          <ul>
            {blockers.map((blocker) => (
              <li key={blocker}>{studioMessage(blocker)}</li>
            ))}
          </ul>
        </div>
      )}
      {approved && !canPublish && (
        <p>A Content Approver with publishing permission must post this package.</p>
      )}
      {complete && (
        <p aria-live="polite">
          {value.isTest
            ? "Publication test completed. Nothing was posted externally."
            : "All included files have been published."}
        </p>
      )}
      {pending && (
        <p aria-live="polite">Publishing is in progress. Results update here automatically.</p>
      )}
      {uncertain && (
        <p aria-live="polite">
          Check the channel for the existing post before retrying; its delivery could not be
          confirmed.
        </p>
      )}
      <div className="actions wrap" style={{ marginTop: 16 }}>
        {approved && canPublish && (
          <button
            type="button"
            className="button primary"
            disabled={disabled}
            onClick={() => {
              const accounts: Partial<Record<StudioChannel, string>> = {};
              for (const channel of channels) {
                const { id } = destination(channel);
                if (id && channel !== "website") accounts[channel] = id;
              }
              onPublish(
                accounts,
                included.map((o) => o.id),
              );
            }}
          >
            {value.isTest ? "Run test publication" : "Post selected files"}
          </button>
        )}
        <button type="button" className="button" disabled={busy} onClick={onRefresh}>
          Refresh publishing status
        </button>
      </div>
    </section>
  );
}
