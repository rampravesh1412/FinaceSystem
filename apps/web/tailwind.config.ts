import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * Design system (§42, §43, §49).
 *
 * Every colour is a CSS variable defined in `src/index.css`, not a literal here. That is
 * what lets dark mode be a genuinely separate token set rather than an inversion — the
 * dark palette re-declares each variable with values chosen for a dark surface, and no
 * component needs a `dark:` variant for colour.
 *
 * The financial tokens (`money.in`, `money.out`, `profit`, `loss`) exist so an amount is
 * never styled with a generic green or red picked ad hoc at the call site. Colour is
 * always paired with a label or glyph in the `<Money>` component — §43 is explicit that
 * colour must not be the only indicator, both for accessibility and because a printed
 * or greyscale report has to stay readable.
 */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1.5rem", screens: { "2xl": "1440px" } },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",

        /** Elevated surfaces: the sidebar, sticky table headers, popovers. */
        surface: {
          DEFAULT: "hsl(var(--surface))",
          muted: "hsl(var(--surface-muted))",
          raised: "hsl(var(--surface-raised))",
        },

        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
          subtle: "hsl(var(--success-subtle))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
          subtle: "hsl(var(--warning-subtle))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
          subtle: "hsl(var(--info-subtle))",
        },

        /* Financial semantics — see the note above. */
        money: {
          in: "hsl(var(--money-in))",
          out: "hsl(var(--money-out))",
          neutral: "hsl(var(--money-neutral))",
        },

        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          muted: "hsl(var(--sidebar-muted))",
          accent: "hsl(var(--sidebar-accent))",
          border: "hsl(var(--sidebar-border))",
        },
      },

      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },

      fontFamily: {
        sans: ["Inter var", "Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        /**
         * Tabular figures for every amount.
         *
         * Proportional digits make a column of numbers ragged and genuinely harder to
         * scan for an accountant checking totals. This is applied by the `<Money>`
         * component and the amount columns of every table.
         */
        mono: ["JetBrains Mono", "SF Mono", "Menlo", "Consolas", "monospace"],
      },

      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.02em" }],
      },

      boxShadow: {
        // Soft and low-contrast: §42 asks for subtle borders and soft shadows, not the
        // heavy drop shadows of a generic admin template.
        subtle: "0 1px 2px 0 hsl(var(--shadow) / 0.04), 0 1px 3px 0 hsl(var(--shadow) / 0.06)",
        card: "0 1px 3px 0 hsl(var(--shadow) / 0.06), 0 8px 24px -12px hsl(var(--shadow) / 0.12)",
        raised: "0 4px 12px -2px hsl(var(--shadow) / 0.10), 0 16px 40px -12px hsl(var(--shadow) / 0.18)",
        focus: "0 0 0 2px hsl(var(--background)), 0 0 0 4px hsl(var(--ring))",
      },

      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
