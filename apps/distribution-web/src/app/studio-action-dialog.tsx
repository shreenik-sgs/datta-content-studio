"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";

/** A single confirmation above the page, with native focus containment and Escape handling. */
export function StudioActionDialog({
  children,
  title,
  busy,
  closeLabel,
  onClose,
}: {
  children: ReactNode;
  title: string;
  busy: boolean;
  closeLabel: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    const overflow = document.body.style.overflow;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
      window.requestAnimationFrame(() => {
        if (element?.open) return;
        const active = document.activeElement;
        if (
          opener?.isConnected &&
          (!active || active === document.body || element?.contains(active))
        )
          opener.focus({ preventScroll: true });
      });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="studio-action-dialog"
      aria-labelledby={titleId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClose={(event) => {
        if (!event.currentTarget.open && !busy) onClose();
      }}
    >
      <h3 id={titleId}>{title}</h3>
      {children}
      <button type="button" className="button" disabled={busy} onClick={onClose}>
        {closeLabel}
      </button>
    </dialog>
  );
}
