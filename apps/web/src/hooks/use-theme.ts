import * as React from "react";

const STORAGE_KEY = "amiri-theme";
type Theme = "light" | "dark";

/**
 * Theme state.
 *
 * The initial class is applied by an inline script in index.html BEFORE React mounts, so
 * a dark-mode user never sees a white flash on load. This hook reads that already-applied
 * state rather than re-deciding it, which is why it initialises from the DOM.
 */
export function useTheme() {
  const [theme, setTheme] = React.useState<Theme>(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  );

  const apply = React.useCallback((next: Theme) => {
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private browsing can refuse writes; the theme still applies for this session.
    }
    setTheme(next);
  }, []);

  const toggle = React.useCallback(() => {
    apply(theme === "dark" ? "light" : "dark");
  }, [theme, apply]);

  // Follow the OS only while the user has expressed no preference of their own.
  React.useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => {
      try {
        if (localStorage.getItem(STORAGE_KEY)) return;
      } catch {
        return;
      }
      document.documentElement.classList.toggle("dark", e.matches);
      setTheme(e.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return { theme, setTheme: apply, toggle };
}
