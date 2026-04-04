const { spawn } = require("node:child_process");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const runningChildren = new Set();

function spawnNpmCommand(args) {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawn(comspec, ["/d", "/s", "/c", `npm ${args.join(" ")}`], {
      cwd: rootDir,
      stdio: "inherit",
    });
  }

  return spawn("npm", args, {
    cwd: rootDir,
    stdio: "inherit",
  });
}

function track(child) {
  runningChildren.add(child);
  child.on("exit", () => runningChildren.delete(child));
  return child;
}

function stopChildren() {
  for (const child of runningChildren) {
    if (!child.killed) {
      child.kill("SIGINT");
    }
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
    stopChildren();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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
