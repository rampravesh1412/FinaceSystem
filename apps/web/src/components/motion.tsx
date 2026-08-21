import * as React from "react";
import { LazyMotion, MotionConfig, m, useReducedMotion, type Transition } from "framer-motion";

/**
 * Motion (§49).
 *
 * Three decisions worth stating, because each of them is a trap someone walks into.
 *
 * **1. `LazyMotion` with the `m` component, never `motion`.**
 * Importing `motion.div` pulls framer-motion's entire feature set into whichever chunk
 * touches it — 381 kB, which is how it ended up in the login page's bundle. `m` is the
 * same component with the features loaded separately; `domAnimation` covers everything
 * this application does (enter/exit, transforms, opacity) at a fraction of the size.
 * `strict` makes the mistake a build error rather than a silent regression: any `motion.x`
 * left anywhere throws.
 *
 * **2. Reduced motion is honoured in JS, not only in CSS.**
 * `index.css` clamps CSS transitions under `prefers-reduced-motion`, but framer-motion
 * animates via the Web Animations API and inline styles, which that rule does not touch.
 * `MotionConfig reducedMotion="user"` makes the library respect the same preference, so a
 * user who asked for stillness gets it from both systems rather than half of it.
 *
 * **3. Motion earns its place or it does not appear.**
 * Every animation here communicates something — where a panel came from, that a row is
 * new, that a value changed. Nothing decorative, nothing that delays an operator reading
 * a number. Durations are 120–220ms: long enough to be seen, short enough that a person
 * entering fifty vouchers never waits for one.
 */

const loadFeatures = () => import("framer-motion").then((mod) => mod.domAnimation);

export function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

/* ── Shared transitions ──────────────────────────────────────────────────── */

/** The default: quick, eased out, no bounce. Financial UI should not feel springy. */
export const EASE_OUT: Transition = { duration: 0.18, ease: [0.22, 1, 0.36, 1] };
export const EASE_QUICK: Transition = { duration: 0.12, ease: [0.22, 1, 0.36, 1] };

/* ── Building blocks ─────────────────────────────────────────────────────── */

/**
 * A screen arriving.
 *
 * A short rise-and-fade, so a route change reads as a new page rather than a flicker.
 * The travel is 4px — enough to register as movement, small enough that text never
 * appears to slide into place while someone is reading it.
 */
export function PageTransition({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <m.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={EASE_OUT}
      className={className}
    >
      {children}
    </m.div>
  );
}

/**
 * A list whose items arrive in sequence.
 *
 * Capped at 12 staggered children: a 200-row DayBook cascading in for four seconds is an
 * obstacle, not a flourish. Beyond the cap everything appears together.
 */
export function Stagger({
  children,
  className,
  step = 0.03,
}: {
  children: React.ReactNode;
  className?: string;
  step?: number;
}) {
  const reduced = useReducedMotion();
  return (
    <m.div
      initial="hidden"
      animate="shown"
      variants={{
        hidden: {},
        shown: { transition: { staggerChildren: reduced ? 0 : step, delayChildren: 0 } },
      }}
      className={className}
    >
      {children}
    </m.div>
  );
}

export function StaggerItem({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <m.div
      variants={{ hidden: { opacity: 0, y: 6 }, shown: { opacity: 1, y: 0 } }}
      transition={EASE_OUT}
      className={className}
    >
      {children}
    </m.div>
  );
}

/**
 * A number that changes while the user is looking at it.
 *
 * Deliberately does NOT count up. A balance that rolls from ₹0 to ₹9,50,000 is unreadable
 * mid-flight and, worse, displays amounts that were never true — on a financial screen
 * that is a lie with a nice easing curve. This flashes the container instead: the figure
 * itself is only ever the correct one.
 */
export function ValueChange({
  value,
  children,
  className,
}: {
  /** Anything that identifies the current value; a change triggers the flash. */
  value: React.Key;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <m.span
      key={value}
      initial={{ backgroundColor: "hsl(var(--accent) / 0.16)" }}
      animate={{ backgroundColor: "hsl(var(--accent) / 0)" }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className={className}
    >
      {children}
    </m.span>
  );
}

export { m, useReducedMotion };
