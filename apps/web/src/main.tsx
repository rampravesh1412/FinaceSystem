import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { toast } from "sonner";
import { Providers } from "./app/providers";
import { router } from "./app/router";
// Imported for its side effect as well as its API: the module attaches the
// `beforeinstallprompt` listener at import time, and Chrome fires that event before React
// has mounted. Registering it inside a component would miss it. See lib/pwa.ts.
import { registerServiceWorker } from "./lib/pwa";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </React.StrictMode>,
);

/**
 * A new build is downloaded in the background and then WAITS.
 *
 * It is not applied silently: activating a new worker reloads the page, and doing that
 * under somebody part-way through entering a payment loses their work. So the choice is
 * theirs, and the toast does not auto-dismiss — an update the user never saw offered is
 * an update they stay on the old build forever.
 */
registerServiceWorker((activate) => {
  toast("A new version of AMIRI Finance is ready", {
    description: "Reload to pick it up. Anything you are part-way through will be lost.",
    duration: Infinity,
    action: { label: "Reload", onClick: activate },
  });
});
