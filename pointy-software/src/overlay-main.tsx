import React from "react";
import ReactDOM from "react-dom/client";

import { Overlay } from "./overlay";
import "./index.css";

// The overlay is its own Tauri window (label "overlay", see tauri.conf.json), so it
// gets its own entry point. StrictMode is deliberately omitted: its double-mount
// would open and close the microphone twice on every hotkey press.
ReactDOM.createRoot(document.getElementById("overlay-root") as HTMLElement).render(
  <React.Fragment>
    <Overlay />
  </React.Fragment>,
);
