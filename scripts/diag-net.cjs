const os = require("os");
console.log("=== ALL IPv4 INTERFACES (unfiltered) ===\n");
for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
  for (const a of addrs) {
    if (a.family === "IPv4") {
      console.log(`  ${name.padEnd(45)} ${a.address.padEnd(18)} internal=${a.internal}`);
    }
  }
}
