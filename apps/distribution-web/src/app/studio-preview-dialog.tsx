"use client";

import { type ReactNode, useEffect, useRef } from "react";

/** Native modal keeps keyboard focus in the preview and restores the file button on close. */
export function StudioPreviewDialog({
  children,
  onClose,
}: { children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previousOverflow = document.body.style.overflow;
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => {
        if (element?.open) return;
        const active = document.activeElement;
        // Closing the modal must not steal focus if the user has already moved to another control.
        if (
          returnFocus?.isConnected &&
          (!active || active === document.body || element?.contains(active))
        )
          returnFocus.focus({ preventScroll: true });
      });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="studio-preview-dialog"
      aria-label="Channel file preview"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={(event) => {
        // Strict Mode reopens the dialog after effect cleanup. The browser's queued
        // close event from that cleanup must not dismiss the newly opened preview.
        if (!event.currentTarget.open) onClose();
      }}
    >
      <div className="preview-dialog-header">
        <strong>Channel file preview</strong>
        <button className="button" type="button" onClick={onClose}>
          Close preview
        </button>
      </div>
      {children}
    </dialog>
  );
}
