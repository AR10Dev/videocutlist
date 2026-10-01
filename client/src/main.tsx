import { RegistryProvider } from "@effect/atom-solid";
import { render } from "solid-js/web";
import { App } from "./App";
import { AccessGate } from "./features/access/AccessGate";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");
render(
  () => (
    <RegistryProvider>
      <AccessGate
        renderWorkspace={() => (
          <RegistryProvider>
            <App />
          </RegistryProvider>
        )}
      />
    </RegistryProvider>
  ),
  root,
);
