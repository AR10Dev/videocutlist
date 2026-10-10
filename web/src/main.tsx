import { RegistryContext, RegistryProvider } from "@effect/atom-solid";
import { onCleanup, useContext } from "solid-js";
import { resolveBrowserConfiguration } from "./api";
import { createAccessBootstrap } from "./features/access/bootstrap";
import { render } from "solid-js/web";
import { App } from "./App";
import { AccessGate } from "./features/access/AccessGate";
import "./style.css";

function Bootstrap() {
  const access = createAccessBootstrap(useContext(RegistryContext), resolveBrowserConfiguration());
  onCleanup(access.dispose);
  return (
    <AccessGate
      access={access}
      renderWorkspace={() => (
        <RegistryProvider>
          <App />
        </RegistryProvider>
      )}
    />
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");
render(
  () => (
    <RegistryProvider>
      <Bootstrap />
    </RegistryProvider>
  ),
  root,
);
