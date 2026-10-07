import { BlockList, isIP } from "node:net";

const deniedAddressRanges: readonly [string, number, "ipv4" | "ipv6"][] = [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.88.99.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["::ffff:0:0", 96, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001::", 23, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["2002::", 16, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
];

const deniedAddressList = new BlockList();
for (const [subnet, prefix, version] of deniedAddressRanges) {
  deniedAddressList.addSubnet(subnet, prefix, version);
}

function isBlockedIp(hostname: string): boolean {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const version = isIP(host);
  if (version === 0) return false;
  return deniedAddressList.check(host, version === 4 ? "ipv4" : "ipv6");
}

export function validateWebhookEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("Webhook endpoint URL is invalid");
  }

  const hostname = endpoint.hostname.toLowerCase().replace(/\.$/, "");
  const hostnameAddress =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const hostnameIsIp = isIP(hostnameAddress) !== 0;
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0 ||
    (endpoint.port.length > 0 && endpoint.port !== "443") ||
    (!hostnameIsIp &&
      (!hostname.includes(".") ||
        hostname === "localhost" ||
        hostname === "metadata" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal") ||
        hostname.endsWith(".home.arpa") ||
        hostname.endsWith(".test"))) ||
    isBlockedIp(hostname)
  ) {
    throw new TypeError("Webhook endpoint is not permitted");
  }
  return endpoint;
}
