import { constants, accessSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/** How far above a starting path to look for a sibling `bin/pi`. */
const INSTALL_WALK_DEPTH = 8;

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the `pi` launcher that owns a package-installed copy: walk up from
 * `start` looking for `bin/pi`.
 *
 * Nix and Guix installs put the launcher at `<store>/bin/pi` and the code at
 * `<store>/lib/pi/node_modules/@earendil-works/pi-coding-agent/...`, so this
 * finds pi even when PATH does not carry the store or profile bin directory.
 */
function executableFromInstall(start: string): string | undefined {
  let dir = resolve(start);
  for (let depth = 0; depth < INSTALL_WALK_DEPTH; depth++) {
    const candidate = join(dir, "bin", "pi");
    if (isExecutable(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function resolvePiExecutable(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  entryPoint: string | undefined = process.argv[1],
): string {
  if (override !== undefined) return override;

  for (const directory of env.PATH?.split(delimiter) ?? []) {
    if (!directory) continue;
    const candidate = resolve(directory, "pi");
    if (isExecutable(candidate)) return candidate;
  }

  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const agentBin = resolve(agentDir, "bin", "pi");
  if (isExecutable(agentBin)) return agentBin;

  // Compiled (Bun) builds run pi itself as the process executable.
  if (basename(process.execPath) === "pi" && isExecutable(process.execPath)) {
    return process.execPath;
  }

  // Package installs (Nix/Guix store paths, local node_modules): derive the
  // launcher from where this pi process was started from.
  for (const start of [env.PI_PACKAGE_DIR, entryPoint && dirname(entryPoint)]) {
    if (!start) continue;
    const found = executableFromInstall(start);
    if (found) return found;
  }

  throw new Error(
    `Could not find the pi executable on PATH, at ${agentBin}, or inside this pi installation. ` +
      `Add pi to PATH, set PI_CODING_AGENT_DIR to its agent directory, or set PI_PACKAGE_DIR to pi's package directory.`,
  );
}
