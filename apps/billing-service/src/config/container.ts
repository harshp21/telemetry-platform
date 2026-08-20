export interface AppContainer {
  readonly serviceName: string;
}

export const createContainer = (serviceName: string): AppContainer => ({ serviceName });
