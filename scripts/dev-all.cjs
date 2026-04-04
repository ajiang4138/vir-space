const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const runningChildren = new Set();
let shuttingDown = false;

function buildNpmCommand(args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      commandArgs: ["/d", "/s", "/c", `npm ${args.join(" ")}`],
    };
  }

  return {
    command: "npm",
    commandArgs: args,
  };
}

function spawnNpmCommand(args) {
  const npm = buildNpmCommand(args);
  return spawn(npm.command, npm.commandArgs, {
    cwd: rootDir,
    stdio: "inherit",
  });
}

function track(child) {
  runningChildren.add(child);
  child.on("exit", () => runningChildren.delete(child));
  return child;
}

function terminateChild(child) {
  if (!child || child.killed) {
    return;
  }

  if (process.platform === "win32") {
    if (typeof child.pid === "number" && child.pid > 0) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
    return;
  }

  child.kill("SIGTERM");
}

function stopChildren() {
  for (const child of runningChildren) {
    terminateChild(child);
  }
}

function main() {
  const relayEnsure = track(spawnNpmCommand(["run", "dev:relay:ensure"]));

  relayEnsure.on("exit", (code, signal) => {
    if (signal || code === 0) {
      return;
    }

    console.error(`[dev-all] relay ensure exited with code ${code}`);
  });

  const client = track(spawnNpmCommand(["run", "dev:client"]));

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    stopChildren();
    setTimeout(() => {
      process.exit(0);
    }, 250);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  client.on("exit", (code, signal) => {
    stopChildren();

    if (signal) {
      process.exit(1);
      return;
    }

    process.exit(code || 0);
  });
}

main();
