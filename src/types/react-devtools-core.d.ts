declare module 'react-devtools-core' {
  export function initialize(): void;
  export function connectToDevTools(options?: {
    host?: string;
    port?: number;
    isAppActive?: () => boolean;
  }): void;
}
