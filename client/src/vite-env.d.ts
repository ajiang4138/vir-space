/// <reference types="vite/client" />

declare global {
  interface Window {
    electronApi: {
      platform: NodeJS.Platform;
      versions: NodeJS.ProcessVersions;
    };
  }
}

export { };

