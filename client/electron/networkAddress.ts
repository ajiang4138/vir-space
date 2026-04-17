import { spawnSync } from "node:child_process";
import os from "node:os";

export interface RankedIpv4Address {
  ip: string;
  interfaceName: string;
  internal: boolean;
  score: number;
}

function isIpv4Address(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }

  return parts.every((part) => {
    if (!/^\d+$/.test(part)) {
      return false;
    }

    const num = Number.parseInt(part, 10);
    return num >= 0 && num <= 255;
  });
}

function isLoopbackIpv4(ip: string): boolean {
  return ip === "127.0.0.1";
}

function isLinkLocalIpv4(ip: string): boolean {
  return ip.startsWith("169.254.");
}

function isKnownHostOnlyVirtualIpv4(ip: string): boolean {
  return ip.startsWith("192.168.56.");
}

function isCarrierGradeNatIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return false;
  }

  const first = Number.parseInt(parts[0], 10);
  const second = Number.parseInt(parts[1], 10);
  return first === 100 && second >= 64 && second <= 127;
}

function isRfc1918_172Ipv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return false;
  }

  const first = Number.parseInt(parts[0], 10);
  const second = Number.parseInt(parts[1], 10);
  return first === 172 && second >= 16 && second <= 31;
}

// On Windows, os.networkInterfaces() returns the connection name (e.g. "Ethernet 7"),
// NOT the adapter description (e.g. "PANGP Virtual Ethernet Adapter Secure"). We query
// PowerShell once at module load to map connection name -> description so we can apply
// VPN keyword detection against the real hardware description.
let _windowsAdapterDescriptions: Map<string, string> | null = null;

function getWindowsAdapterDescriptions(): Map<string, string> {
  if (_windowsAdapterDescriptions !== null) {
    return _windowsAdapterDescriptions;
  }

  _windowsAdapterDescriptions = new Map();

  if (process.platform !== "win32") {
    return _windowsAdapterDescriptions;
  }

  try {
    // Get-NetAdapter outputs Name and InterfaceDescription columns.
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-NetAdapter | Select-Object Name,InterfaceDescription | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 3000, windowsHide: true },
    );

    if (result.status !== 0 || !result.stdout) {
      return _windowsAdapterDescriptions;
    }

    const parsed = JSON.parse(result.stdout.trim()) as
      | Array<{ Name: string; InterfaceDescription: string }>
      | { Name: string; InterfaceDescription: string };

    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (typeof entry.Name === "string" && typeof entry.InterfaceDescription === "string") {
        _windowsAdapterDescriptions.set(entry.Name, entry.InterfaceDescription);
      }
    }
  } catch {
    // Best-effort — if PowerShell fails, fall back to connection-name-only scoring.
  }

  return _windowsAdapterDescriptions;
}

/** Returns true if the string (name or description) looks like a VPN adapter. */
function looksLikeVpnLabel(label: string): boolean {
  return /(vpn|wireguard|nordlynx|proton|tailscale|zerotier|hamachi|openvpn|ipsec|ikev2|l2tp|pptp|sstp|ppp|utun|tun|tap|wg|anyconnect|fortinet|forticlient|globalprotect|pangp|paloalto|palo.?alto|cisco|pulse|juniper|zscaler|mullvad|surfshark|expressvpn|private.?internet.?access|\bpia\b|cloudflare|warp)/.test(
    label.toLowerCase(),
  );
}

/** Returns true if the string looks like a plain Wi-Fi / wireless adapter. */
function looksLikeWifiLabel(label: string): boolean {
  return /(wi-?fi|wifi|wireless|wlan)/.test(label.toLowerCase());
}

/** Returns true if the string looks like a VM/container virtual adapter (not VPN). */
function looksLikeVirtualLabel(label: string): boolean {
  return /(vbox|vmware|hyper-v|vethernet|docker|podman|wsl|loopback|virbr|bridge)/.test(
    label.toLowerCase(),
  );
}

function scoreInterfaceName(name: string): number {
  // On Windows, also check the real adapter description (e.g. "PANGP Virtual Ethernet
  // Adapter Secure") which contains the VPN brand name that the connection name lacks.
  const description = getWindowsAdapterDescriptions().get(name) ?? "";

  // VPN check must come before the virtual-adapter check because VPN adapters like
  // "PANGP Virtual Ethernet Adapter Secure" contain "virtual" in the description.
  if (looksLikeVpnLabel(name) || looksLikeVpnLabel(description)) {
    return -40;
  }

  if (looksLikeWifiLabel(name) || looksLikeWifiLabel(description)) {
    return 8;
  }

  if (looksLikeVirtualLabel(name) || looksLikeVirtualLabel(description)) {
    return 20;
  }

  return 0;
}

function scoreIpAddress(ip: string, internal: boolean): number {
  if (isLoopbackIpv4(ip)) {
    return 100;
  }

  if (internal) {
    return 90;
  }

  if (isLinkLocalIpv4(ip)) {
    return 80;
  }

  if (isKnownHostOnlyVirtualIpv4(ip)) {
    return 70;
  }

  // Prefer common VPN ranges over typical home LAN addressing.
  if (isCarrierGradeNatIpv4(ip)) {
    return -25;
  }

  if (ip.startsWith("25.") || ip.startsWith("26.")) {
    return -18;
  }

  if (ip.startsWith("10.")) {
    return -12;
  }

  if (isRfc1918_172Ipv4(ip)) {
    return -10;
  }

  if (ip.startsWith("192.168.")) {
    return 6;
  }

  return 0;
}

export function getRankedIpv4Addresses(): RankedIpv4Address[] {
  const bestByIp = new Map<string, RankedIpv4Address>();

  for (const [interfaceName, interfaces] of Object.entries(os.networkInterfaces())) {
    if (!interfaces) {
      continue;
    }

    for (const detail of interfaces) {
      if (detail.family !== "IPv4" || !detail.address || !isIpv4Address(detail.address)) {
        continue;
      }

      const score = scoreIpAddress(detail.address, detail.internal) + scoreInterfaceName(interfaceName);
      const candidate: RankedIpv4Address = {
        ip: detail.address,
        interfaceName,
        internal: detail.internal,
        score,
      };

      const existing = bestByIp.get(candidate.ip);
      if (!existing || candidate.score < existing.score) {
        bestByIp.set(candidate.ip, candidate);
      }
    }
  }

  const ranked = Array.from(bestByIp.values()).sort((left, right) => {
    const scoreDelta = left.score - right.score;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    const ifaceDelta = left.interfaceName.localeCompare(right.interfaceName);
    if (ifaceDelta !== 0) {
      return ifaceDelta;
    }

    return left.ip.localeCompare(right.ip);
  });

  if (ranked.length === 0) {
    return [{ ip: "127.0.0.1", interfaceName: "loopback", internal: true, score: 100 }];
  }

  return ranked;
}

export function getPreferredNonLoopbackIpv4Addresses(): string[] {
  return getRankedIpv4Addresses()
    .map((entry) => entry.ip)
    .filter((ip) => !isLoopbackIpv4(ip) && !isLinkLocalIpv4(ip) && !isKnownHostOnlyVirtualIpv4(ip));
}

export function getPreferredIpv4AddressesIncludingLoopback(): string[] {
  const nonLoopback = getPreferredNonLoopbackIpv4Addresses();
  if (nonLoopback.length === 0) {
    return ["127.0.0.1"];
  }

  return [...nonLoopback, "127.0.0.1"];
}
