import { execFile } from "child_process";
import { existsSync, promises as fs } from "fs";
import { basename, join } from "path";
import { ANSI_RE, parsePiListOutput } from "@/lib/omp/plugins-cli";
import { PI_NOT_FOUND, resolvePiBin } from "@/lib/omp/omp-cli";
import { ensureAgentDir } from "@/lib/omp/paths";
import { createChildProcessEnvironment } from "@/lib/project-command-env";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import type {
  PluginDiagnostic,
  PluginPackageInfo,
  PluginResourceCounts,
  PluginResourceInfo,
  PluginScope,
  PluginsResponse,
} from "@/lib/api-types";

// Package management is delegated to the user's pi binary (`pi install/remove/update/list`); tau never embeds its SDK.
// `pi list` prints text only (parsePiListOutput) and has no enable/disable command.

type PluginAction = "install" | "remove" | "update";

function emptyCounts(): PluginResourceCounts {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

function runPi(
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const bin = resolvePiBin();
  if (!bin) {
    return Promise.reject(new Error(PI_NOT_FOUND));
  }
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: createChildProcessEnvironment({ FORCE_COLOR: "0", NO_COLOR: "1" }),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || error.message).replace(ANSI_RE, "").trim();
          reject(new Error(detail.slice(-600) || `pi ${args.join(" ")} failed`));
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/** Best-effort scan of a package's skills/ directory so the UI can show a resource count. */
async function scanPluginSkills(pluginPath: string): Promise<PluginResourceInfo[]> {
  const skillsDir = join(pluginPath, "skills");
  let entries;
  try {
    const readDirectory = Reflect.get(fs, "readdir") as typeof fs.readdir;
    entries = await readDirectory(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const resources: PluginResourceInfo[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    if (existsSync(skillPath)) {
      resources.push({
        kind: "skill",
        name: entry.name,
        path: skillPath,
        relativePath: join("skills", entry.name, "SKILL.md"),
      });
    }
  }
  return resources;
}

/** Without a cwd, the user level only (a cluster member's settings act on this machine's, spec K7): pi runs in its
 * agent directory, where no project lies, and a project-scope entry is left out all the same. */
async function readPlugins(cwd: string | null): Promise<PluginsResponse> {
  const diagnostics: PluginDiagnostic[] = [];
  const packages: PluginPackageInfo[] = [];
  const totals = emptyCounts();

  try {
    const { stdout } = await runPi(["list"], { cwd: cwd ?? ensureAgentDir(), timeout: 60_000 });
    const piPackages = parsePiListOutput(stdout);
    for (const pkg of piPackages) {
      if (!cwd && pkg.scope === "project") continue;
      const installed = Boolean(pkg.path && existsSync(pkg.path));
      const resources = pkg.path ? await scanPluginSkills(pkg.path) : [];
      const counts = emptyCounts();
      counts.skills = resources.length;
      packages.push({
        source: pkg.source,
        scope: pkg.scope,
        filtered: false,
        disabled: false,
        installedPath: pkg.path || undefined,
        packageName: basename(pkg.path) || pkg.source,
        version: undefined,
        configuredVersion: undefined,
        counts,
        resources,
        status: resources.length > 0 ? "loaded" : installed ? "installed" : "missing",
      });
    }
    for (const pkg of packages) {
      totals.extensions += pkg.counts.extensions;
      totals.skills += pkg.counts.skills;
      totals.prompts += pkg.counts.prompts;
      totals.themes += pkg.counts.themes;
    }
  } catch (error) {
    diagnostics.push({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return { packages, totals, diagnostics };
}

function readScope(scope: unknown): PluginScope {
  return scope === "project" ? "project" : "global";
}

/** Dynamic CLI failures keep their message; a missing pi binary is the one
 * known cause worth a stable code for client-side localization. */
function pluginErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(PI_NOT_FOUND)) {
    return Response.json({ error: message, code: "omp_not_found" }, { status: 500 });
  }
  return Response.json({ error: message }, { status: 500 });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");

  try {
    if (cwd && !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
      return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }
    return Response.json(await readPlugins(cwd));
  } catch (error) {
    return pluginErrorResponse(error);
  }
}

// POST /api/plugins body: { action, source?, scope?, cwd? }; without a cwd, global changes only.
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      action?: PluginAction;
      source?: string;
      scope?: PluginScope;
      cwd?: string;
    };
    const cwd = body.cwd || null;
    const scope = readScope(body.scope);
    if (!cwd && scope === "project") return Response.json({ error: "cwd required", code: "cwd_required" }, { status: 400 });
    if (!body.action) return Response.json({ error: "action required", code: "action_required" }, { status: 400 });
    if (cwd && !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
      return Response.json({ error: "Access denied", code: "access_denied" }, { status: 403 });
    }

    const source = body.source?.trim();
    const scopeArgs = scope === "project" ? ["-l"] : [];
    const dir = cwd ?? ensureAgentDir();

    if (body.action === "install") {
      if (!source) return Response.json({ error: "source required", code: "source_required" }, { status: 400 });
      await runPi(["install", source, ...scopeArgs], { cwd: dir, timeout: 300_000 });
    } else if (body.action === "remove") {
      if (!source) return Response.json({ error: "source required", code: "source_required" }, { status: 400 });
      await runPi(["remove", source, ...scopeArgs], { cwd: dir, timeout: 120_000 });
    } else if (body.action === "update") {
      // A bare `pi update` updates pi itself: without a source, the packages only.
      await runPi(["update", ...(source ? [source] : ["--extensions"])], { cwd: dir, timeout: 300_000 });
    } else {
      return Response.json({ error: `Unsupported action: ${body.action}`, code: "plugin_unsupported_action" }, { status: 400 });
    }

    return Response.json(await readPlugins(cwd));
  } catch (error) {
    return pluginErrorResponse(error);
  }
}
