import { createSignal, For, Show } from "solid-js";
import { useWorkspace } from "../app/WorkspaceContext";

const permissionLabels: Record<string, string> = {
  "media:read": "Read media metadata",
  "projects:read": "Read projects",
  "projects:write": "Create and edit projects",
  "previews:create": "Create previews",
  "detection:run": "Run detection",
  "exports:prepare": "Prepare exports",
  "exports:run": "Run approved exports",
  "jobs:read": "Read job status",
  "jobs:cancel": "Cancel jobs",
  "exports:download": "Download exports",
};

const splitIDs = (value: string) => value.split(/[\s,]+/).filter(Boolean);

export function MCPSettings() {
  const {
    mcpSettings,
    mcpPending,
    settingsPending,
    revealedMCPSecret,
    setMCPEnabled,
    createMCPCredential,
    revokeMCPCredential,
  } = useWorkspace();
  const [name, setName] = createSignal("");
  const [permissions, setPermissions] = createSignal<string[]>([]);
  const [expiry, setExpiry] = createSignal("7d");
  const [nonExpiringAcknowledged, setNonExpiringAcknowledged] = createSignal(false);
  const [mediaScope, setMediaScope] = createSignal("all");
  const [rootIDs, setRootIDs] = createSignal<string[]>([]);
  const [mediaIDs, setMediaIDs] = createSignal("");
  const [projectScope, setProjectScope] = createSignal("all");
  const [projectIDs, setProjectIDs] = createSignal("");
  const [unattendedExports, setUnattendedExports] = createSignal(false);

  const updatePermission = (permission: string, checked: boolean) => {
    setPermissions((current) => {
      const next = checked
        ? [...new Set([...current, permission])]
        : current.filter((value) => value !== permission);
      if (permission === "projects:write" && checked && !next.includes("projects:read"))
        next.push("projects:read");
      return permission === "projects:read" && !checked
        ? next.filter((value) => value !== "projects:write")
        : next;
    });
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const duration = expiry() === "1d" ? 1 : expiry() === "7d" ? 7 : 30;
    const never = expiry() === "never";
    const created = await createMCPCredential({
      name: name(),
      permissions: permissions(),
      mediaScope:
        mediaScope() === "roots"
          ? { kind: "roots", rootIds: rootIDs() }
          : mediaScope() === "media"
            ? { kind: "media", mediaIds: splitIDs(mediaIDs()) }
            : { kind: "all" },
      projectScope:
        projectScope() === "projects"
          ? { kind: "projects", projectIds: splitIDs(projectIDs()) }
          : { kind: "all" },
      expiresAt: never
        ? undefined
        : new Date(Date.now() + duration * 24 * 60 * 60 * 1000).toISOString(),
      allowNonExpiring: never ? nonExpiringAcknowledged() : false,
      unattendedExports: unattendedExports(),
    });
    if (created) {
      setName("");
      setPermissions([]);
      setUnattendedExports(false);
    }
  };

  return (
    <section aria-labelledby="mcp-settings-heading">
      <h3 id="mcp-settings-heading">MCP access</h3>
      <Show when={mcpSettings()} fallback={<p>Loading MCP administration settings…</p>}>
        {(settings) => (
          <>
            <label>
              <input
                class="toggle toggle-sm"
                type="checkbox"
                checked={settings().enabled}
                disabled={settingsPending()}
                onChange={(event) => void setMCPEnabled(event.currentTarget.checked)}
              />
              Enable MCP
            </label>
            <p>
              Disabled by default. Enabling MCP does not change the server listener, firewall, or
              remote access.
            </p>
            <div class="card card-border card-sm my-3">
              <div class="card-body">
                <h4 class="card-title">Connection</h4>
                <p>
                  Endpoint: <code>{settings().endpoint}</code>
                </p>
                <p>
                  Send <code>Authorization: Bearer &lt;one-time-secret&gt;</code> with every MCP
                  request.
                </p>
                <p>{settings().remoteAccessGuidance}</p>
                <p>{settings().clientCompatibility}</p>
              </div>
            </div>
            <Show when={revealedMCPSecret()}>
              <div class="alert alert-warning alert-soft my-3" role="alert">
                <div class="w-full">
                  <strong>Copy this secret now.</strong> It cannot be viewed again.
                  <input
                    class="input input-sm mt-2 w-full font-mono"
                    aria-label="One-time MCP bearer secret"
                    readOnly
                    value={revealedMCPSecret()}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </div>
              </div>
            </Show>
            <form class="card card-border card-sm my-3" onSubmit={submit}>
              <div class="card-body">
                <h4 class="card-title">Create credential</h4>
                <label>
                  Credential name
                  <input
                    class="input input-sm"
                    required
                    maxlength="120"
                    value={name()}
                    onInput={(event) => setName(event.currentTarget.value)}
                  />
                </label>
                <fieldset class="fieldset">
                  <legend class="fieldset-legend">Permissions</legend>
                  <p class="label">No permissions are selected by default.</p>
                  <For each={settings().permissions}>
                    {(permission) => (
                      <label>
                        <input
                          class="checkbox checkbox-sm"
                          type="checkbox"
                          checked={permissions().includes(permission)}
                          onChange={(event) =>
                            updatePermission(permission, event.currentTarget.checked)
                          }
                        />
                        {permissionLabels[permission] ?? permission} <code>{permission}</code>
                      </label>
                    )}
                  </For>
                </fieldset>
                <label>
                  Expiration
                  <select
                    class="select select-sm"
                    value={expiry()}
                    onChange={(event) => setExpiry(event.currentTarget.value)}
                  >
                    <option value="1d">1 day</option>
                    <option value="7d">7 days</option>
                    <option value="30d">30 days</option>
                    <option value="never">Never expires</option>
                  </select>
                </label>
                <Show when={expiry() === "never"}>
                  <label>
                    <input
                      class="checkbox checkbox-warning checkbox-sm"
                      type="checkbox"
                      required
                      checked={nonExpiringAcknowledged()}
                      onChange={(event) => setNonExpiringAcknowledged(event.currentTarget.checked)}
                    />
                    I understand that this credential remains valid until revoked.
                  </label>
                </Show>
                <label>
                  Media scope
                  <select
                    class="select select-sm"
                    value={mediaScope()}
                    onChange={(event) => setMediaScope(event.currentTarget.value)}
                  >
                    <option value="all">All media</option>
                    <option value="roots">Selected configured roots</option>
                    <option value="media">Selected media IDs</option>
                  </select>
                </label>
                <Show when={mediaScope() === "roots"}>
                  <fieldset class="fieldset">
                    <legend class="fieldset-legend">Configured roots</legend>
                    <For
                      each={settings().roots}
                      fallback={<p class="label">No configured roots.</p>}
                    >
                      {(root) => (
                        <label>
                          <input
                            class="checkbox checkbox-sm"
                            type="checkbox"
                            checked={rootIDs().includes(root.id)}
                            onChange={(event) =>
                              setRootIDs((current) =>
                                event.currentTarget.checked
                                  ? [...current, root.id]
                                  : current.filter((id) => id !== root.id),
                              )
                            }
                          />
                          {root.label}
                        </label>
                      )}
                    </For>
                  </fieldset>
                </Show>
                <Show when={mediaScope() === "media"}>
                  <label>
                    Media IDs (comma or space separated)
                    <input
                      class="input input-sm"
                      required
                      value={mediaIDs()}
                      onInput={(event) => setMediaIDs(event.currentTarget.value)}
                    />
                  </label>
                </Show>
                <label>
                  Project scope
                  <select
                    class="select select-sm"
                    value={projectScope()}
                    onChange={(event) => setProjectScope(event.currentTarget.value)}
                  >
                    <option value="all">All projects</option>
                    <option value="projects">Selected project IDs</option>
                  </select>
                </label>
                <Show when={projectScope() === "projects"}>
                  <label>
                    Project IDs (comma or space separated)
                    <input
                      class="input input-sm"
                      required
                      value={projectIDs()}
                      onInput={(event) => setProjectIDs(event.currentTarget.value)}
                    />
                  </label>
                </Show>
                <label>
                  <input
                    class="checkbox checkbox-warning checkbox-sm"
                    type="checkbox"
                    checked={unattendedExports()}
                    onChange={(event) => setUnattendedExports(event.currentTarget.checked)}
                  />
                  Allow exports without in-app approval
                </label>
                <p class="label">
                  Unattended exports still require export permissions, validation, and processing
                  limits.
                </p>
                <div class="card-actions">
                  <button class="btn btn-sm" type="submit" disabled={mcpPending()}>
                    {mcpPending() ? "Creating…" : "Create credential"}
                  </button>
                </div>
              </div>
            </form>
            <h4>Credentials</h4>
            <Show
              when={settings().credentials.length > 0}
              fallback={<p>No MCP credentials created.</p>}
            >
              <ul aria-label="MCP credentials">
                <For each={settings().credentials}>
                  {(credential) => (
                    <li class="card card-border card-sm">
                      <div class="card-body">
                        <div class="flex flex-wrap items-center gap-2">
                          <strong>{credential.name}</strong>
                          <span
                            class="badge badge-sm"
                            classList={{
                              "badge-success": credential.status === "active",
                              "badge-warning": credential.status === "expired",
                              "badge-error": credential.status === "revoked",
                            }}
                          >
                            {credential.status}
                          </span>
                        </div>
                        <p>Token ID: {credential.tokenIdentifier}</p>
                        <p>Permissions: {credential.permissions.join(", ") || "none"}</p>
                        <p>
                          Expires:{" "}
                          {credential.expiresAt
                            ? new Date(credential.expiresAt).toLocaleString()
                            : "never"}
                        </p>
                        <p>
                          Last used:{" "}
                          {credential.lastUsedAt
                            ? new Date(credential.lastUsedAt).toLocaleString()
                            : "never"}
                        </p>
                        <Show when={credential.status === "active"}>
                          <div class="card-actions">
                            <button
                              class="btn btn-error btn-outline btn-sm"
                              type="button"
                              disabled={mcpPending()}
                              onClick={() => void revokeMCPCredential(credential.id)}
                            >
                              Revoke {credential.name}
                            </button>
                          </div>
                        </Show>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
