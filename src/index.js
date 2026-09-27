import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";
import App from "./App";

// Keep the screen from zooming: iOS Safari ignores user-scalable=no for
// pinches, so block its pinch-zoom gesture events directly.
["gesturestart", "gesturechange", "gestureend"].forEach((type) =>
  document.addEventListener(type, (e) => e.preventDefault(), {
    passive: false,
  }),
);

const rootElement = document.getElementById("root");
const root = createRoot(rootElement);

root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
