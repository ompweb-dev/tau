import type { RpcTransport } from "../pi/rpc-transport";
import type { SessionOps } from "./session-ops";
import type { WorkspaceOps } from "../workspace-types";

export type HostStatus = "online" | "offline" | "needs-upgrade" | "pi-missing";

/** The link carries traffic: sends, ops and children work. An pi-missing host
 * is linked too; only spawning there fails, with its own error. */
export function isLinkUp(status: HostStatus): boolean {
  return status === "online" || status === "pi-missing";
}

export interface SpawnRequest {
  /** Stable identity of one independent start; retries must preserve its spawn arguments. */
  creationId?: string;
  /** Daemon only: the server URL whose link supplies `configVersion`. Never trusted from the wire. */
  configServer?: string;
  /** Hub → daemon: the master's configuration version this process must run with; the daemon applies it first. Never recorded for resume. */
  configVersion?: string;
  cwd: string;
  recordedCwd: string | null;
  sessionFile: string;
  toolNames?: string[];
  /** `provider/modelId` bound at spawn (--model); resume only. */
  spawnModel?: string;
}

export interface SpawnResult {
  transport: RpcTransport;
  cwd: string;
  fellBack: boolean;
  /** Existing shared channel: startup/ready already completed on the daemon. */
  joined?: boolean;
  pending?: string[];
  streaming?: string | null;
}

/** A machine pi sessions run on. Every machine-local action of a session goes through it. */
export interface Host {
  readonly id: string;
  readonly label: string;
  status(): HostStatus;
  onStatus(listener: (status: HostStatus) => void): () => void;
  spawnRpc(request: SpawnRequest, sessionId?: string | null, options?: { preparing?: boolean; expectedChannel?: string }): Promise<SpawnResult>;
  sessionFileExists(path: string): Promise<boolean>;
  invalidateSessionLists(sessionFile?: string): void;
  /** Session and project file operations, run on this host. */
  readonly sessionOps: SessionOps;
  readonly workspaceOps: WorkspaceOps;
}
