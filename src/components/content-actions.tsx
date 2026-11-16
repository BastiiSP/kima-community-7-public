"use client";

import { useEffect, useRef } from "react";

type Props = {
  label: string;
  disabled?: boolean;
  onEdit?: () => void;
  onDelete: () => void;
};

export function ContentActions({ label, disabled = false, onEdit, onDelete }: Props) {
  const details = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);

  useEffect(() => {
    function outside(event: PointerEvent) {
      if (details.current?.open && event.target instanceof Node && !details.current.contains(event.target)) {
        details.current.open = false;
      }
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && details.current?.open) {
        event.preventDefault();
        event.stopPropagation();
        details.current.open = false;
        trigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    const closeOnMove = () => { if (details.current) details.current.open = false; };
    window.addEventListener("resize", closeOnMove);
    document.addEventListener("scroll", closeOnMove, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", closeOnMove);
      document.removeEventListener("scroll", closeOnMove, true);
    };
  }, []);

  function select(action: () => void) {
    if (disabled) return;
    if (details.current) details.current.open = false;
    trigger.current?.focus();
    action();
  }

  return <details className="content-actions" ref={details} onToggle={event => {
    if (!event.currentTarget.open) return;
    document.querySelectorAll<HTMLDetailsElement>("details.content-actions[open]").forEach(other => {
      if (other !== event.currentTarget) other.open = false;
    });
    const panel = event.currentTarget.querySelector<HTMLElement>(".content-actions-panel");
    const anchor = trigger.current?.getBoundingClientRect();
    if (panel && anchor) {
      const box = panel.getBoundingClientRect();
      // Fixed positioning keeps actions reachable inside the scrollable chat.
      panel.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8))}px`;
      panel.style.top = `${Math.max(8, Math.min(anchor.bottom, window.innerHeight - box.height - 8))}px`;
    }
  }}>
    <summary ref={trigger} aria-label={label} title={label} aria-disabled={disabled} tabIndex={disabled ? -1 : 0}
      onClick={event => { if (disabled) event.preventDefault(); }}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
        <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
      </svg>
    </summary>
    <div className="content-actions-panel">
      {onEdit && <button type="button" disabled={disabled} onClick={() => select(onEdit)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="m16 3 5 5M4 15 16 3a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3L9 20l-6 1 1-6Z" />
        </svg>Bearbeiten
      </button>}
      <button type="button" className="danger" disabled={disabled} onClick={() => select(onDelete)}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
        </svg>Löschen
      </button>
    </div>
  </details>;
}
