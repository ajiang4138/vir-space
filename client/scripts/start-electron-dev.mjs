import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const basePort = Number.parseInt(process.env.VITE_DEV_PORT_BASE ?? "5173", 10);
const portSpan = Number.parseInt(process.env.VITE_DEV_PORT_SPAN ?? "20", 10);
const waitTimeoutMs = Number.parseInt(process.env.VITE_DEV_WAIT_TIMEOUT_MS ?? "120000", 10);
const probeIntervalMs = 250;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function isViteServerReady(port) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), 800);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/@vite/client`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return false;
    }

    const source = await response.text();
    return source.includes("/@vite/client") || source.includes("createHotContext");
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function findVitePort() {
  const startMs = Date.now();
  const ports = Array.from({ length: portSpan + 1 }, (_, index) => basePort + index);

  while (Date.now() - startMs < waitTimeoutMs) {
    for (const port of ports) {
      if (await isViteServerReady(port)) {
        return port;
      }
    }

    await sleep(probeIntervalMs);
  }

  throw new Error(
    `Timed out after ${waitTimeoutMs}ms waiting for Vite on ports ${ports[0]}-${ports[ports.length - 1]}.`,
  );
}

function resolveElectronBinary() {
  return require("electron");
}

async function main() {
  const port = await findVitePort();
  const viteDevServerUrl = `http://127.0.0.1:${port}`;

  console.log(`[dev:electron] detected Vite dev server at ${viteDevServerUrl}`);

  const child = spawn(resolveElectronBinary(), ["dist-electron/electron/main.js"], {
    stdio: "inherit",
    cwd: path.resolve(scriptDir, ".."),
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: viteDevServerUrl,
    },
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
      return;
    }

    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[dev:electron] ${message}`);
  process.exit(1);
});
