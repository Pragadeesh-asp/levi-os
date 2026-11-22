"use client";

import { useActionState, useId, useRef } from "react";
import type { ReactNode } from "react";
import type { ActionResult } from "@/lib/action-result";
import { reward } from "@/lib/reward";
import type { SakugaButtonElement } from "@/types/sakuga-vfx";
import { ImpactSubmit } from "./Sakuga";

export type ServerAction = (state: ActionResult | null, formData: FormData) => Promise<ActionResult>;

/**
 * Wraps a form around a server action and renders its outcome.
 *
 * Accessibility notes: the submit button reflects the pending state, success and error
 * messages are announced with `role="status"` / `role="alert"`, and every field keeps a
 * real `<label>` — the action's message never replaces the form.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  submitClassName = "button",
  pendingLabel = "Saving…",
  hidden,
  resetOnSuccess = true,
  className,
  disabled,
  ariaLabel,
  title,
  effect,
}: {
  action: ServerAction;
  children: ReactNode;
  submitLabel: string;
  submitClassName?: string;
  pendingLabel?: string;
  hidden?: Record<string, string>;
  resetOnSuccess?: boolean;
  className?: string;
  /** Renders the submit button as unavailable (e.g. a move that cannot happen). */
  disabled?: boolean;
  /** Accessible name for a button whose visible text is a glyph. */
  ariaLabel?: string;
  title?: string;
  /** "impact": the sakuga-vfx button for moments that earn XP. Text-label buttons only. */
  effect?: "impact";
}) {
  const impact = useRef<SakugaButtonElement>(null);
  // The reward plays inside the action, before React commits the result: completing a
  // mission swaps Complete for Reopen in that commit, so an effect here would never see
  // the success. reward() explains the short beat it holds for the check.
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(async (previous, formData) => {
    const result = await action(previous, formData);
    await reward(result, effect === "impact" ? impact.current : null);
    return result;
  }, null);
  const statusId = useId();

  return (
    <form
      action={formAction}
      className={className}
      // Remounting on success clears the inputs so the same entry is not submitted twice.
      key={resetOnSuccess && state?.ok ? (state.message ?? "ok") : "form"}
    >
      <div className="stack-sm">
        {hidden
          ? Object.entries(hidden).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))
          : null}
        {children}
        <div className="row">
          {effect === "impact" ? (
            <ImpactSubmit
              ref={impact}
              label={submitLabel}
              pendingLabel={pendingLabel}
              pending={pending}
              disabled={disabled}
              title={title}
              describedBy={statusId}
            />
          ) : (
            <button
              className={submitClassName}
              type="submit"
              disabled={pending || disabled}
              aria-label={ariaLabel}
              title={title}
              aria-describedby={statusId}
            >
              {pending ? pendingLabel : submitLabel}
            </button>
          )}
        </div>
        <div id={statusId}>
          {state && !state.ok && state.error ? (
            <p className="notice error" role="alert">
              {state.error}
            </p>
          ) : null}
          {state?.ok && state.message ? (
            <p className="notice success" role="status">
              {state.message}
              {state.unlocked && state.unlocked.length > 0
                ? ` Achievement unlocked: ${state.unlocked.join(", ")}.`
                : ""}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}

/** A plain icon-button form for one-shot mutations (complete, skip, delete…). */
export function ActionButton({
  action,
  label,
  fields,
  variant = "secondary",
  confirm,
  pendingLabel,
  disabled,
  ariaLabel,
  title,
  effect,
}: {
  action: ServerAction;
  label: string;
  fields: Record<string, string>;
  variant?: "secondary" | "danger" | "ghost";
  confirm?: string;
  pendingLabel?: string;
  disabled?: boolean;
  ariaLabel?: string;
  title?: string;
  /** "impact" for completions that earn XP; see ActionForm. */
  effect?: "impact";
}) {
  return (
    <ActionForm
      action={action}
      submitLabel={label}
      submitClassName={`button ${variant} tiny`}
      pendingLabel={pendingLabel ?? label}
      hidden={fields}
      resetOnSuccess={false}
      disabled={disabled}
      ariaLabel={ariaLabel}
      title={title}
      effect={effect}
    >
      {confirm ? <input type="hidden" name="confirm" value="yes" /> : null}
    </ActionForm>
  );
}
