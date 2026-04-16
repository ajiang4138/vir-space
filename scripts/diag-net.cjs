const os = require("os");
const ifaces = os.networkInterfaces();

console.log("=== ALL IPv4 NETWORK INTERFACES ===\n");
for (const [name, addrs] of Object.entries(ifaces)) {
  for (const a of addrs) {
    if (a.family === "IPv4") {
      console.log(name.padEnd(45) + a.address.padEnd(18) + " internal=" + a.internal);
    }
  }
}

console.log("\n=== AFTER VIRTUAL ADAPTER FILTER ===\n");
for (const [name, addrs] of Object.entries(ifaces)) {
  if (!addrs) continue;
  const lower = name.toLowerCase();
  if (lower.includes("virtual") || lower.includes("vbox") || lower.includes("wsl") || lower.includes("loopback")) {
    console.log("[EXCLUDED by name] " + name);
    continue;
  }
  for (const a of addrs) {
    if (a.family !== "IPv4" || a.internal) continue;
    if (a.address.startsWith("169.254.") || a.address.startsWith("192.168.56.")) {
      console.log("[EXCLUDED by IP]   " + name.padEnd(35) + a.address);
      continue;
    }
    console.log("[INCLUDED]         " + name.padEnd(35) + a.address);
  }
}

console.log("\n=== SORTED BY SCORE (lower = preferred) ===\n");
const score = (ip) => {
  if (ip.startsWith("100.")) return 0;
  if (ip.startsWith("25.")) return 1;
  if (ip.startsWith("10.")) return 2;
  if (ip.startsWith("172.")) return 3;
  if (ip.startsWith("192.168.")) return 4;
  return 5;
};

const included = [];
for (const [name, addrs] of Object.entries(ifaces)) {
  if (!addrs) continue;
  const lower = name.toLowerCase();
  if (lower.includes("virtual") || lower.includes("vbox") || lower.includes("wsl") || lower.includes("loopback")) continue;
  for (const a of addrs) {
    if (a.family !== "IPv4" || a.internal) continue;
    if (a.address.startsWith("169.254.") || a.address.startsWith("192.168.56.")) continue;
    included.push({ name, ip: a.address, score: score(a.address) });
  }
}

included.sort((a, b) => a.score - b.score || a.ip.localeCompare(b.ip));
for (const entry of included) {
  console.log("score=" + entry.score + "  " + entry.ip.padEnd(18) + entry.name);
}

console.log("\n=== PREFERRED (first in list) ===");
console.log(included.length > 0 ? included[0].ip : "<none>");
