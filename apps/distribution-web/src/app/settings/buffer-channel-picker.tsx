"use client";
import { useState } from "react";
export function BufferChannelPicker({
  platform,
  preserveLabel = false,
}: { platform: "youtube"; preserveLabel?: boolean }) {
  const [channels, setChannels] = useState<{ id: string; label: string; available: boolean }[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="button"
        disabled={busy}
        onClick={async (event) => {
          const form = event.currentTarget.form;
          if (!form) return;
          const token = String(new FormData(form).get("accessToken") ?? "").trim();
          if (!token) {
            setMessage("Enter your Buffer API key above, then find your channels.");
            return;
          }
          setBusy(true);
          setMessage("");
          setChannels([]);
          try {
            const response = await fetch("/distribution/api/settings/buffer-channels", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ accessToken: token }),
            });
            const data = await response.json();
            if (!response.ok) throw Error(data.error);
            setChannels(data.channels);
            setMessage(
              data.channels.length
                ? "Choose the intended YouTube channel below. Nothing has been saved or posted."
                : "No YouTube channels found. Connect your channel in Buffer first, then try again.",
            );
          } catch (error) {
            setMessage(
              error instanceof Error && error.message === "BUFFER_AUTH_REQUIRED"
                ? "Buffer rejected that API key. Check or replace it in Buffer Settings → API."
                : "Could not read your Buffer channels. Check the key and connection, then try again.",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Finding channels…" : "Find my YouTube channels"}
      </button>
      {message && <p aria-live="polite">{message}</p>}
      {channels.length > 0 && (
        <label>
          Choose your {platform === "youtube" ? "YouTube" : platform} channel
          <select
            defaultValue=""
            onChange={(event) => {
              const selected = channels.find((channel) => channel.id === event.target.value);
              const form = event.currentTarget.form;
              if (!selected || !form) return;
              const id = form.elements.namedItem("providerAccountId");
              const label = form.elements.namedItem("label");
              if (id instanceof HTMLInputElement) id.value = selected.id;
              if (label instanceof HTMLInputElement && !preserveLabel)
                label.value = selected.label.slice(0, 120);
            }}
          >
            <option value="">Choose a channel</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id} disabled={!channel.available}>
                {channel.label}
                {channel.available ? "" : " · Reconnect or unlock in Buffer"}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
