"use client";
import type {
  ImportVerificationAction,
  ImportVerificationState,
} from "@satsang/distribution-contracts";
import {
  COMPUTER_RECOVERY_ORIGIN,
  IMPORT_RECOVERY_ERRORS,
  type OnlineImport,
} from "@satsang/distribution-domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { PlaylistOriginals } from "./playlist-originals";
export function ImportRecovery({
  item,
  items,
  onSaved,
}: { item: OnlineImport; items: OnlineImport[]; onSaved: () => Promise<void> }) {
  const [session, setSession] = useState<ImportVerificationState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [image, setImage] = useState("");
  const [onStaging, setOnStaging] = useState(false);
  useEffect(() => {
    setOnStaging(window.location.origin === COMPUTER_RECOVERY_ORIGIN);
  }, []);
  const delivered = useRef<string | null>(null);
  const signInSeen = useRef<string | null>(null);
  const automaticCheck = useRef<string | null>(null);
  const commandQueue = useRef(Promise.resolve());
  const requests = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  const pending = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const request of requests.current) request.abort();
    };
  }, []);
  const send = useCallback(
    async (command: ImportVerificationAction) => {
      if (!mounted.current) return;
      const controller = new AbortController();
      requests.current.add(controller);
      // Allow the server's bounded browser startup, but never leave the controls stuck forever.
      const timer = setTimeout(
        () => controller.abort(),
        command.action === "start" ? 75000 : 25000,
      );
      let response: Response;
      let data: ImportVerificationState & { error?: string };
      try {
        response = await fetch(`/distribution/api/content/import/${item.id}/verification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
          signal: controller.signal,
        });
        data = await response.json();
      } catch {
        if (!mounted.current) return;
        throw Error(
          controller.signal.aborted
            ? "The verification connection timed out. Your playlist is saved. Try again; access has not yet been confirmed."
            : "The verification connection was interrupted. Your playlist is saved. Try again.",
        );
      } finally {
        clearTimeout(timer);
        requests.current.delete(controller);
      }
      if (!mounted.current) return;
      if (!response.ok) {
        if (data.error === "VERIFICATION_EXPIRED") {
          setSession(null);
          setImage("");
        }
        throw Error(
          IMPORT_RECOVERY_ERRORS[data.error ?? ""] ??
            "Verification could not be reached. Your playlist is saved.",
        );
      }
      setError("");
      setSession(data.status === "CLOSED" ? null : data);
      setImage(data.image ?? "");
      if (data.status === "VERIFIED" && delivered.current !== data.sessionId) {
        delivered.current = data.sessionId;
        await onSaved();
      }
    },
    [item.id, onSaved],
  );
  const enqueue = useCallback(
    (command: ImportVerificationAction, interactive = true) => {
      if (interactive) {
        pending.current += 1;
        setBusy(true);
        setError("");
      }
      commandQueue.current = commandQueue.current
        .then(() => send(command))
        .catch((e) => {
          if (mounted.current)
            setError(e instanceof Error ? e.message : "Verification is unavailable.");
        })
        .finally(() => {
          if (interactive) pending.current -= 1;
          if (mounted.current) setBusy(pending.current > 0);
        });
      return commandQueue.current;
    },
    [send],
  );
  const perform = (command: ImportVerificationAction) => void enqueue(command);
  const sessionId = session?.sessionId;
  const sessionStatus = session?.status;
  const signInBlocked = session?.error === "VERIFICATION_SIGN_IN_BLOCKED";
  const signingIn = session?.origin === "https://accounts.google.com";
  useEffect(() => {
    if (!sessionId || sessionStatus !== "OPEN") return;
    if (signingIn) signInSeen.current = sessionId;
    if (
      signInSeen.current === sessionId &&
      session?.origin === "https://www.youtube.com" &&
      automaticCheck.current !== sessionId
    ) {
      // Returning from Google allows one ordinary access attempt, not an assumption
      // that verification succeeded. Only a saved recording marks it verified.
      automaticCheck.current = sessionId;
      void enqueue({ action: "check", sessionId });
    }
  }, [sessionId, sessionStatus, signingIn, session?.origin, enqueue]);
  useEffect(() => {
    if (!sessionId || !sessionStatus || !["OPEN", "CHECKING"].includes(sessionStatus)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      // Status snapshots share the input queue so a stale poll cannot reopen a closed window.
      if (!stopped) await enqueue({ action: "status", sessionId }, false);
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sessionId, sessionStatus, enqueue]);
  const verificationNeeded =
    item.source.provider === "youtube" &&
    (item.serviceIssue?.code === "ONLINE_PROVIDER_VERIFICATION_REQUIRED" ||
      ["ONLINE_PROVIDER_VERIFICATION_REQUIRED", "ONLINE_SOURCE_RESTRICTED"].includes(
        item.error ?? "",
      ) ||
      items.some(
        (child) => item.childIds?.includes(child.id) && child.error === "ONLINE_SOURCE_RESTRICTED",
      ));
  return (
    <section className="import-recovery" aria-label="Recover source imports">
      {onStaging && item.childIds?.length && (verificationNeeded || signInBlocked) ? (
        <section className="panel computer-recovery-offer" aria-label="Recover using this computer">
          <h3>Recover using this computer</h3>
          <p>
            Use local Studio to download missing recordings and transfer them back to this playlist.
            Completed recordings and shared settings are preserved.
          </p>
          <a
            className="button primary"
            href={`http://localhost:3070/distribution/recover?bundle=${item.id}`}
            target="_blank"
            rel="noreferrer"
          >
            Open local recovery
          </a>
          <p className="muted">
            Requires Studio running on this computer at localhost:3070 and your staging Curator
            sign-in. If the page does not open, start local Studio first. YouTube may still refuse
            local access.
          </p>
        </section>
      ) : null}
      {verificationNeeded && !session && (
        <>
          <p>
            Studio already tried downloading automatically. YouTube requires an access check.
            Complete any sign-in or verification in the browser below. Your playlist and shared
            settings stay in place.
            {item.source.kind === "video" || item.childIds?.length
              ? " You can also upload the original recordings below."
              : " The recording list must load before original files can be matched to this playlist."}
          </p>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => perform({ action: "start" })}
          >
            {busy ? "Opening verification…" : "Verify YouTube access"}
          </button>
        </>
      )}
      {session && session.status !== "CLOSED" && (
        <section className="panel verification-window" aria-label="YouTube verification">
          <h3>YouTube access verification</h3>
          {session.status === "OPEN" && (
            <p>
              Complete any sign-in or verification YouTube presents here. Studio checks access
              automatically when Google sign-in returns to YouTube. Otherwise, use Check access and
              resume playlist after completing the check. This session expires automatically.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {session.status === "OPEN" && image && (
            <>
              {signingIn && (
                <output>
                  Finish Google sign-in here before checking access. Use your password or Google’s
                  “Try another way” option. Device/passkey prompts can open outside this embedded
                  window; if “Connecting to your device” gets stuck, cancel that prompt and choose
                  another sign-in method. Complete any verification Google requests yourself.
                </output>
              )}
              <p>
                Page: {session.origin}. Click inside the window to interact and type. Use Next field
                in YouTube and Enter to move through its controls.
              </p>
              <button
                type="button"
                className="verification-screen"
                aria-label="YouTube browser: click to interact, then type; Tab leaves this window"
                onClick={(event) => {
                  event.currentTarget.focus();
                  const box = event.currentTarget.getBoundingClientRect();
                  perform({
                    action: "click",
                    sessionId: session.sessionId,
                    x: Math.max(
                      0,
                      Math.min(1023, Math.floor(((event.clientX - box.left) * 1024) / box.width)),
                    ),
                    y: Math.max(
                      0,
                      Math.min(767, Math.floor(((event.clientY - box.top) * 768) / box.height)),
                    ),
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Tab") return;
                  event.preventDefault();
                  if (event.ctrlKey || event.metaKey || event.altKey) return;
                  if (event.key.length === 1)
                    perform({ action: "text", sessionId: session.sessionId, text: event.key });
                  else if (
                    [
                      "Enter",
                      "Backspace",
                      "Delete",
                      "Escape",
                      "ArrowUp",
                      "ArrowDown",
                      "ArrowLeft",
                      "ArrowRight",
                      "Home",
                      "End",
                    ].includes(event.key)
                  )
                    perform({
                      action: "key",
                      sessionId: session.sessionId,
                      key: event.key as "Enter",
                    });
                }}
              >
                <img
                  src={image}
                  alt="Private YouTube verification browser"
                  draggable={false}
                  width={1024}
                  height={768}
                />
              </button>
              <div className="actions">
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    perform({ action: "key", sessionId: session.sessionId, key: "Tab" })
                  }
                >
                  Next field in YouTube
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    perform({ action: "scroll", sessionId: session.sessionId, delta: 512 })
                  }
                >
                  Scroll down
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    perform({ action: "scroll", sessionId: session.sessionId, delta: -512 })
                  }
                >
                  Scroll up
                </button>
              </div>
              <button
                type="button"
                className="button primary"
                disabled={busy || signingIn}
                onClick={() => perform({ action: "check", sessionId: session.sessionId })}
              >
                {signingIn
                  ? "Finish Google sign-in to check access"
                  : "Check access and resume playlist"}
              </button>
            </>
          )}
          {session.status === "CHECKING" && (
            <output>
              Downloading one recording to confirm access. A long recording can take several
              minutes. Your playlist resumes only after that recording is saved. You can close
              verification to cancel this check; existing drafts are kept.
            </output>
          )}
          {session.status === "VERIFIED" && (
            <output>
              Access verified by a successful download. Unfinished recordings are continuing with
              your saved settings.
            </output>
          )}
          {session.status === "FAILED" && (
            <>
              <p role="alert">
                {IMPORT_RECOVERY_ERRORS[session.error ?? ""] ??
                  IMPORT_RECOVERY_ERRORS.VERIFICATION_FAILED}
              </p>
              {signInBlocked ? (
                <a
                  href="https://support.google.com/accounts/answer/7675428"
                  target="_blank"
                  rel="noreferrer"
                >
                  Why Google can block this sign-in
                </a>
              ) : (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => perform({ action: "start" })}
                >
                  Open verification again
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => {
              if (session.status === "VERIFIED") setSession(null);
              else perform({ action: "cancel", sessionId: session.sessionId });
            }}
          >
            Close verification
          </button>
        </section>
      )}
      {!session && error && <p role="alert">{error}</p>}
      <PlaylistOriginals item={item} items={items} onSaved={onSaved} expanded={signInBlocked} />
    </section>
  );
}
