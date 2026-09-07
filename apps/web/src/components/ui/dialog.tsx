import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-background/70 backdrop-blur-sm",
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * A bottom sheet on a phone, a centred dialog from `sm` up.
 *
 * Every create/edit form in the application is a Dialog, and centred-and-vertically-
 * middled is the wrong shape for all of them on a 360px screen: the box floats with dead
 * space above and below, and the moment the soft keyboard opens it is shoved off the top
 * of the viewport with the field you are typing into.
 *
 * Anchored to the bottom edge instead, it behaves the way a native sheet does — it grows
 * upward from where your thumb is, the keyboard pushes into space the sheet already owns,
 * and `dvh` rather than `vh` means the height tracks the *visible* viewport as mobile
 * browser chrome slides in and out. (`vh` is frozen at the largest possible viewport, so
 * a `90vh` sheet is taller than the screen whenever the URL bar is showing — which is why
 * the last field of a long form used to be unreachable.)
 *
 * The layout is mobile-first, and every desktop property is reintroduced under `sm:` —
 * including neutralising the slide-up animation back to the original zoom. Callers keep
 * passing `sm:max-w-*` exactly as before.
 */
const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        // ── Phone: a sheet on the bottom edge ──
        "fixed inset-x-0 bottom-0 z-50 grid max-h-[92dvh] w-full gap-4 overflow-y-auto",
        "rounded-t-2xl border-t border-border bg-card shadow-raised",
        // The bottom padding clears the home indicator on a gesture-navigation phone.
        "p-5 pb-[max(1.25rem,var(--safe-b))]",
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",

        // ── sm and up: the original centred dialog, restored property by property ──
        "sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[85dvh] sm:max-w-lg",
        "sm:-translate-x-1/2 sm:-translate-y-1/2",
        "sm:rounded-lg sm:border sm:p-6",
        "sm:data-[state=closed]:slide-out-to-bottom-0 sm:data-[state=open]:slide-in-from-bottom-0",
        "sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95",
        className,
      )}
      {...props}
    >
      {children}
      {/*
        Larger and on a background on touch screens. It sits over scrolling content in a
        tall form, and a bare 16px glyph with no ground under it is both hard to hit and
        hard to see against a table of figures.
      */}
      <DialogPrimitive.Close className="absolute right-3.5 top-3.5 flex size-8 items-center justify-center rounded-full bg-surface-muted/80 text-muted-foreground backdrop-blur transition-colors hover:bg-surface-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:right-4 sm:top-4 sm:size-auto sm:rounded-sm sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
        <X className="size-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

/**
 * Stacked and full-width on a phone, a right-aligned row from `sm`.
 *
 * `[&>*]:w-full` is what actually makes the stacked buttons full width — the buttons are
 * `inline-flex`, so `flex-col` alone leaves them centred at their content width, which on
 * a touch screen is a small target in the middle of a wide sheet.
 */
const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 [&>*]:w-full",
      "sm:flex-row sm:justify-end sm:[&>*]:w-auto",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-lg font-semibold tracking-tight", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog, DialogPortal, DialogOverlay, DialogClose, DialogTrigger,
  DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
};
