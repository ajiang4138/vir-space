/// <reference types="vite/client" />

import type { FileManifest, PickedFileInfo, ReceiverTransferHandle } from "./shared/fileTransfer";
import type { HostServiceInfo, LocalNetworkInfo } from "./shared/signaling";

interface ImportMetaEnv {
  readonly VITE_BOOTSTRAP_SIGNALING_URL?: string;
  readonly VITE_STUN_URLS?: string;
  readonly VITE_TURN_URLS?: string;
  readonly VITE_TURN_USERNAME?: string;
  readonly VITE_TURN_CREDENTIAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    electronApi: {
      platform: NodeJS.Platform;
      versions: NodeJS.ProcessVersions;
      startHostService: (requestedPort?: number) => Promise<HostServiceInfo>;
      stopHostService: () => Promise<HostServiceInfo>;
      getHostServiceStatus: () => Promise<HostServiceInfo>;
      getLocalNetworkInfo: () => Promise<LocalNetworkInfo>;
      getCachedRelayBootstrapHost: () => Promise<string | null>;
      selectFileForSharing: () => Promise<PickedFileInfo | null>;
      buildFileManifest: (filePath: string, roomId: string, senderPeerId: string, pieceSize: number) => Promise<FileManifest>;
      readFilePiece: (filePath: string, pieceIndex: number, pieceSize: number) => Promise<Uint8Array>;
      createReceiverTransfer: (manifest: FileManifest) => Promise<ReceiverTransferHandle>;
      writeReceiverPiece: (transferId: string, pieceIndex: number, data: Uint8Array) => Promise<void>;
      finalizeReceiverTransfer: (transferId: string) => Promise<{ savedPath: string; verifiedHash: string }>;
      cancelReceiverTransfer: (transferId: string) => Promise<void>;
    };
  }
}

export { };

