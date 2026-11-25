import type { HostRow, LocalHostRow } from "@/lib/hosts/hub";
import { isLinkUp } from "@/lib/hosts/host";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export const HOST_STATUS_COLOR = { online: "var(--status-success)", offline: "var(--text-dim)", "pi-missing": "var(--status-warning)", "needs-upgrade": "var(--status-warning)" } as const;

/** The name a host goes by in the UI: this machine is localized until the user names it, linked hosts keep their label. */
export function hostName(t: Translate, host: Pick<HostRow, "id" | "label">): string {
  return host.id === "local" && !host.label ? t("hostsConfig.thisMachine") : host.label;
}

export const isLocalRow = (host: HostRow): host is LocalHostRow => host.id === "local";

/** The command that installs the tau-host service on the server's platform (`LocalHostRow.serverPlatform`). */
export function localInstallCommand(platform: string): string {
  if (platform === "darwin") return "tau launchd install";
  return platform === "win32" ? "tau-tray install" : "tau systemd install";
}

export function hostStatusText(t: Translate, host: HostRow): string {
  switch (host.status) {
    case "online":
      return t("hostsConfig.statusOnline");
    case "pi-missing":
      return t("hostsConfig.statusPiMissing");
    case "needs-upgrade":
      return t("hostsConfig.statusNeedsUpgrade", { host: "hostVersion" in host ? host.hostVersion ?? "?" : "?", server: "serverVersion" in host ? host.serverVersion : "?" });
    default:
      return t("hostsConfig.statusOffline");
  }
}

/** Why a host's sessions cannot be opened or started right now (null when they can, or the host is unknown). */
export function hostUnavailableReason(t: Translate, hosts: readonly HostRow[] | null, hostId: string): string | null {
  const row = hosts?.find((host) => host.id === hostId);
  if (!row || isLinkUp(row.status)) return null;
  return t("hosts.unavailableReason", { host: hostName(t, row), status: hostStatusText(t, row) });
}
