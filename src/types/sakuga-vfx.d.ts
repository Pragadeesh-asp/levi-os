import type { DetailedHTMLProps, HTMLAttributes } from "react";

/**
 * The two sakuga-vfx custom elements LEVI OS uses. The scripts are vendored,
 * unchanged, in public/sakuga-vfx (MIT; provenance in docs/THIRD_PARTY.md).
 */
export interface SakugaButtonElement extends HTMLElement {
  disabled: boolean;
  /** Lands a check with a glint; it fades after `hold` seconds (0 keeps it). */
  done(hold?: number): void;
  /** Plays the click reaction without a click. */
  impact(): void;
}

export interface SakugaToastElement extends HTMLElement {
  readonly open: boolean;
  /** Shows one line of text (set with textContent, never as HTML). */
  show(text?: string): void;
  hide(): void;
}

type ElementProps<T> = DetailedHTMLProps<HTMLAttributes<T>, T>;

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "sakuga-button": ElementProps<SakugaButtonElement> & {
        type?: "submit" | "button";
        variant?: "secondary";
        disabled?: boolean;
      };
      "sakuga-toast": ElementProps<SakugaToastElement> & {
        duration?: string;
        message?: string;
      };
    }
  }
}
