"use client";
import type {
  ComputerRecoveryAction,
  ComputerRecoveryState,
} from "@satsang/distribution-contracts";
import {
  COMPUTER_RECOVERY_ERRORS,
  COMPUTER_RECOVERY_ORIGIN,
  computerRecoveryBundle,
} from "@satsang/distribution-domain";
import { useCallback, useEffect, useRef, useState } from "react";

const playlistLink = (id: string) =>
  `${COMPUTER_RECOVERY_ORIGIN}/distribution?view=studio&bundle=${id}`;
const idle: ComputerRecoveryState = { status: "IDLE", recordings: 0, completed: 0 };
export function ComputerRecovery({ initialBundle }: { initialBundle?: string | undefined }) {
  const [link, setLink] = useState(initialBundle ? playlistLink(initialBundle) : "");
  const [bundle, setBundle] = useState(initialBundle ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<ComputerRecoveryState>(idle);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const running = ["RUNNING", "STOPPING"].includes(state.status);
  const queue = useRef(Promise.resolve());
  const requests = useRef(new Set<AbortController>());
  const version = useRef(0);
  const perform = useCallback(
    (command: ComputerRecoveryAction, interactive = true) => {
      if (!bundle) return Promise.resolve();
      const generation = version.current;
      if (interactive) setBusy(true);
      queue.current = queue.current.then(async () => {
        if (generation !== version.current) return;
        const controller = new AbortController();
        requests.current.add(controller);
        const timer = setTimeout(() => controller.abort(), 30000);
        try {
          const response = await fetch(
            `/distribution/api/content/import/${bundle}/computer-recovery`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(command),
              signal: controller.signal,
            },
          );
          const data = await response.json();
          if (!response.ok)
            throw Error(response.status === 401 ? "LOCAL_SIGN_IN_REQUIRED" : data.error);
          if (generation === version.current) {
            setState(data);
            setError("");
          }
        } catch (e) {
          if (generation !== version.current) return;
          const code = e instanceof Error ? e.message : "";
          setError(
            code === "LOCAL_SIGN_IN_REQUIRED"
              ? "Your local session ended. Sign in again, then return to this page to see recovery progress."
              : (COMPUTER_RECOVERY_ERRORS[code] ??
                  "The local recovery service could not be reached. Your playlist is saved. Check progress again before restarting recovery."),
          );
        } finally {
          if (command.action === "start") command.password = "";
          clearTimeout(timer);
          requests.current.delete(controller);
          if (generation === version.current && interactive) setBusy(false);
        }
      });
      return queue.current;
    },
    [bundle],
  );
  useEffect(() => {
    void perform({ action: "status" });
    return () => {
      version.current += 1;
      for (const controller of requests.current) controller.abort();
    };
  }, [perform]);
  useEffect(() => {
    if (!running || error) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await perform({ action: "status" }, false);
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [running, error, perform]);
  const phase = {
    connecting: "Connecting to staging",
    checking: "Checking saved download",
    downloading: "Downloading on this computer",
    uploading: "Transferring to staging",
  };
  const playlistForm = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const id = computerRecoveryBundle(link);
        if (!id) {
          setError(COMPUTER_RECOVERY_ERRORS.RECOVERY_INVALID_PLAYLIST ?? "Invalid playlist");
          return;
        }
        if (id === bundle) {
          void perform({ action: "status" });
          return;
        }
        setState(idle);
        setError("");
        setBundle(id);
        window.history.replaceState(null, "", `/distribution/recover?bundle=${id}`);
      }}
    >
      <label>
        Staging playlist link
        <input
          type="url"
          required
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder={`${COMPUTER_RECOVERY_ORIGIN}/distribution?view=studio&bundle=…`}
        />
      </label>
      <button className="button" type="submit" disabled={busy}>
        Open recovery
      </button>
    </form>
  );
  return (
    <section className="panel computer-recovery-panel" aria-label="Recover staging playlist">
      <p>
        Download missing recordings on this computer and transfer them to the same GBADPT staging
        playlist. Its shared permissions and output settings stay in place.
      </p>
      <p className="muted">
        Keep this computer awake and local Studio running. You can leave this page and return to
        check progress. Recovery does not approve or post content.
      </p>
      {!running &&
        (bundle ? (
          <details>
            <summary>Change playlist</summary>
            {playlistForm}
          </details>
        ) : (
          playlistForm
        ))}
      {bundle && (
        <>
          {state.status !== "IDLE" && (
            <div className="computer-recovery-progress" aria-live="polite">
              <h2>{state.title ?? "Playlist recovery"}</h2>
              {state.recordings > 0 && (
                <>
                  <p>
                    <strong>
                      {state.completed} of {state.recordings}
                    </strong>{" "}
                    recordings saved on staging
                  </p>
                  <progress
                    value={state.completed}
                    max={state.recordings}
                    aria-label="Recordings saved on staging"
                  />
                </>
              )}
              {state.status === "RUNNING" && (
                <p>
                  {phase[state.phase ?? "connecting"]}
                  {state.currentTitle ? `: ${state.currentTitle}` : "…"}
                </p>
              )}
              {state.status === "STOPPING" && (
                <p>Stopping safely. A transfer already accepted by staging may finish.</p>
              )}
              {state.status === "PAUSED" && (
                <p>
                  Recovery stopped. Sign in below to resume; completed recordings will be skipped.
                </p>
              )}
              {state.status === "COMPLETE" && (
                <p>
                  All recordings are saved on staging. Curation continues using the playlist
                  settings. Generated files still need your review.
                </p>
              )}
              {state.error && (
                <p className="notice error" role="alert">
                  {COMPUTER_RECOVERY_ERRORS[state.error] ??
                    COMPUTER_RECOVERY_ERRORS.RECOVERY_INTERRUPTED}
                </p>
              )}
            </div>
          )}
          {!running && state.status !== "COMPLETE" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || !username.trim() || !password) return;
                void perform({ action: "start", username: username.trim(), password });
                setPassword("");
              }}
            >
              <h3>Sign in to GBADPT staging</h3>
              <p className="muted">
                Use your staging Studio Curator account. This is not a Google sign-in. The password
                is used once and is not saved.
              </p>
              <label>
                Staging username or email
                <input
                  required
                  maxLength={254}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </label>
              <label>
                Staging password
                <input
                  type="password"
                  required
                  maxLength={256}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button type="submit" className="button primary" disabled={busy}>
                {busy
                  ? "Connecting…"
                  : state.status === "IDLE"
                    ? "Start recovery"
                    : "Resume recovery"}
              </button>
            </form>
          )}
          {running && (
            <button
              className="button"
              disabled={busy || state.status === "STOPPING"}
              type="button"
              onClick={() => void perform({ action: "stop" })}
            >
              Stop recovery
            </button>
          )}
          {error && (
            <div className="notice error" role="alert">
              <p>{error}</p>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void perform({ action: "status" })}
              >
                Check progress again
              </button>
            </div>
          )}
          <a className="button quiet" href={playlistLink(bundle)} target="_blank" rel="noreferrer">
            View playlist on staging
          </a>
        </>
      )}
      <p className="muted">
        Local access can also be refused by YouTube. This feature does not bypass sign-in, CAPTCHA
        or restricted media.
      </p>
    </section>
  );
}
