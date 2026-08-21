import * as React from "react";

/**
 * Debounce a value.
 *
 * Used on every search box (§69): a keystroke-per-request search against a
 * multi-million-row transaction table is a self-inflicted denial of service.
 */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
