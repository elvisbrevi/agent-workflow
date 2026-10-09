import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { WebAccess } from "./components/WebAccess.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WebAccess><App /></WebAccess>
  </StrictMode>,
);
