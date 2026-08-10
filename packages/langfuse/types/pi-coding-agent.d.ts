declare module "@earendil-works/pi-coding-agent" {
  export interface EventBus {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
  }

  export interface ExtensionContext {
    sessionManager?: {
      getSessionId?: () => unknown;
      getSessionFile?: () => unknown;
    };
  }

  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: any) => unknown): void;
    events: EventBus;
    registerCommand(
      name: string,
      options: { description?: string; handler: (args: string, ctx: any) => unknown },
    ): void;
  }
}
