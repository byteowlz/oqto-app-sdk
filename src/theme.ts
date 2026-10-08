import type { OqtoThemeSnapshot } from "./types.js";

/** Inline value a helper-owned token replaced, so withdrawal can restore it. */
interface PriorValue {
  readonly value: string;
  readonly priority: string;
}

/** Per-root record of the tokens this helper applied and what they replaced. */
const owned = new WeakMap<HTMLElement, Map<string, PriorValue>>();

/**
 * Apply a host theme to one app root without mutating global document state.
 *
 * Each call is a full snapshot, not a patch: a token applied by an earlier call
 * and omitted by this one is withdrawn. Withdrawal restores the inline value the
 * root had before this helper first set that token (or removes it when there
 * was none), so app-owned custom properties are never cleared. Only `--`
 * custom properties are applied; other names are ignored.
 */
export function applyOqtoTheme(element: HTMLElement, theme: OqtoThemeSnapshot): void {
  const style = element.style;
  let applied = owned.get(element);
  if (!applied) {
    applied = new Map();
    owned.set(element, applied);
  }

  const incoming = Object.entries(theme.tokens).filter(([name]) => name.startsWith("--"));
  const names = new Set(incoming.map(([name]) => name));

  for (const [name, prior] of applied) {
    if (names.has(name)) continue;
    if (prior.value === "") style.removeProperty(name);
    else style.setProperty(name, prior.value, prior.priority);
    applied.delete(name);
  }

  for (const [name, value] of incoming) {
    if (!applied.has(name)) {
      applied.set(name, {
        value: style.getPropertyValue(name),
        priority: style.getPropertyPriority(name),
      });
    }
    style.setProperty(name, value);
  }

  element.dataset.oqtoColorScheme = theme.colorScheme;
}
