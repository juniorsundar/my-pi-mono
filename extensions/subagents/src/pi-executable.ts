import { constants, accessSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { homedir } from "node:os";

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolvePiExecutable(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
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

  throw new Error(
    `Could not find the pi executable on PATH or at ${agentBin}. Add pi to PATH or set PI_CODING_AGENT_DIR to its agent directory.`,
  );
}
