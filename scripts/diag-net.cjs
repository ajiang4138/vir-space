const os = require("os");

const ipScore = (ip) => {
  if (ip.startsWith("100.")) return 0;
  if (ip.startsWith("25.")) return 1;
  if (ip.startsWith("10.")) return 2;
  if (ip.startsWith("172.")) return 3;
  if (ip.startsWith("192.168.")) return 4;
  return 5;
};

const ifaceScore = (name) => {
  const lower = name.toLowerCase();
  if (lower.includes("wi-fi") || lower.includes("wifi") || lower.includes("wireless") || lower.includes("wlan")) return 1;
  return 0;
};

const entries = [];
for (const [name, interfaces] of Object.entries(os.networkInterfaces())) {
  if (!interfaces) continue;
  const lower = name.toLowerCase();
  if (lower.includes("virtual") || lower.includes("vbox") || lower.includes("wsl") || lower.includes("loopback")) continue;
  for (const a of interfaces) {
    if (a.family !== "IPv4" || a.internal) continue;
    if (a.address.startsWith("169.254.") || a.address.startsWith("192.168.56.")) continue;
    entries.push({ ip: a.address, ifaceName: name, ipScore: ipScore(a.address), ifaceScore: ifaceScore(name) });
  }
}

entries.sort((a, b) => {
  const d1 = a.ipScore - b.ipScore;
  if (d1 !== 0) return d1;
  const d2 = a.ifaceScore - b.ifaceScore;
  if (d2 !== 0) return d2;
  return a.ip.localeCompare(b.ip);
});

console.log("=== IP PRIORITY ORDER (VPN/Ethernet before Wi-Fi) ===\n");
for (const e of entries) {
  const type = e.ifaceScore === 0 ? "Ethernet/VPN" : "Wi-Fi";
  console.log(`  ${e.ip.padEnd(18)} ${e.ifaceName.padEnd(20)} ipScore=${e.ipScore}  type=${type}`);
}
console.log(`\n  PREFERRED: ${entries[0]?.ip || "<none>"} (${entries[0]?.ifaceName || "?"})`);
