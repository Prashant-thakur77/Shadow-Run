import { useEffect, useRef, useState } from 'react';

/** Reseeding throws away everyone's changes, because everyone on the demo shares one prod. So it asks first. */
export function ReseedButton({ onConfirm, busy, className = 'btn', label = 'Reseed', busyLabel = 'Reseeding', what = 'demo prod' }: { onConfirm: () => void; busy: boolean; className?: string; label?: string; busyLabel?: string; what?: string }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    // The safe choice takes the focus, so Enter on its own can't throw anyone's work away.
    cancel.current?.focus();
  }, [open]);
  return (
    <>
      <button type="button" ref={opener} className={className} disabled={busy} onClick={() => setOpen(true)}>
        {busy ? busyLabel : label}
      </button>
      {open && (
        <dialog
          ref={dialog}
          className="dialog dialog-confirm"
          aria-labelledby="reseed-title"
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
        >
          <h2 className="dialog-title" id="reseed-title">
            Reseed {what}?
          </h2>
          <p className="muted">This puts it back to the seed and removes any learned guardrails. Everyone on this demo shares one prod, so it also removes other visitors' changes, and a plan someone has approved will stop at the drift check.</p>
          <div className="row gap-s dialog-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                dialog.current?.close();
                onConfirm();
              }}
            >
              Reseed
            </button>
            <button type="button" className="btn" ref={cancel} onClick={() => dialog.current?.close()}>
              Cancel
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
