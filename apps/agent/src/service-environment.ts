import { dirname, isAbsolute } from "node:path";

const DEFAULT_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Shared admission for values persisted in the service definition's XML text. */
export function validateServiceText(value: string): void {
  for (const char of value) {
    const cp = char.codePointAt(0)!;
    if (
      !(
        cp === 9 ||
        cp === 10 ||
        cp === 13 ||
        (cp >= 32 && cp <= 0xd7ff) ||
        (cp >= 0xe000 && cp <= 0xfffd) ||
        (cp >= 0x10000 && cp <= 0x10ffff)
      )
    ) {
      throw new Error("invalid XML character in service definition");
    }
  }
}

function absolute(value: string, name: string): string {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  validateServiceText(value);
  return value;
}

export function serviceEnvironment(input: {
  stateDir: string;
  serviceInstance: string;
  nodePath: string;
  env: NodeJS.ProcessEnv;
}): Record<string, string> {
  absolute(input.stateDir, "stateDir");
  absolute(input.nodePath, "nodePath");
  if (!UUID.test(input.serviceInstance)) throw new Error("serviceInstance must be a UUID");
  const pathEntries = [
    dirname(input.nodePath),
    ...(input.env.PATH?.split(":") ?? []),
    ...DEFAULT_PATH,
  ].filter((entry) => entry.length > 0 && isAbsolute(entry));
  const environment: Record<string, string> = {
    SHELLBELL_DIR: input.stateDir,
    SHELLBELL_SERVICE_INSTANCE: input.serviceInstance,
    PATH: [...new Set(pathEntries)].join(":"),
  };
  for (const name of ["HERDR_SOCKET_PATH", "XDG_CONFIG_HOME"] as const) {
    const value = input.env[name];
    if (value) environment[name] = absolute(value, name);
  }
  for (const value of Object.values(environment)) validateServiceText(value);
  return environment;
}
