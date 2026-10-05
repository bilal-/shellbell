export interface ServiceDefinition {
  nodePath: string;
  cliPath: string;
  stateDir: string;
  serviceInstance: string | null;
  environment: Record<string, string>;
  logPath: string;
}

export interface ServiceSnapshot {
  startupEnabled?: boolean | null;
  installed: boolean;
  loaded: boolean;
  raw: Buffer | null;
  definition: ServiceDefinition | null;
}

export interface ServiceManager {
  readonly kind: "launchd";
  readonly definitionPath: string;
  inspect(): Promise<ServiceSnapshot>;
  write(definition: ServiceDefinition): Promise<void>;
  restore(raw: Buffer | null): Promise<void>;
  load(): Promise<number>;
  unload(): Promise<void>;
  setStartupEnabled(enabled: boolean): Promise<void>;
}
