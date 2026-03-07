import { getLocalIpAddress } from "../src/network.js";

describe("getLocalIpAddress", () => {
  it("should return the first non-loopback IPv4 address", () => {
    const mockInterfaces = () => ({
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      eth0: [
        { family: "IPv6", address: "fe80::1", internal: false },
        { family: "IPv4", address: "192.168.1.42", internal: false },
      ],
    });

    expect(getLocalIpAddress(mockInterfaces)).toBe("192.168.1.42");
  });

  it("should return the first IPv4 found when multiple interfaces exist", () => {
    const mockInterfaces = () => ({
      eth0: [{ family: "IPv4", address: "10.0.0.1", internal: false }],
      wlan0: [{ family: "IPv4", address: "192.168.1.50", internal: false }],
    });

    expect(getLocalIpAddress(mockInterfaces)).toBe("10.0.0.1");
  });

  it("should return null when no non-loopback IPv4 interface is found", () => {
    const mockInterfaces = () => ({
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    });

    expect(getLocalIpAddress(mockInterfaces)).toBeNull();
  });

  it("should return null when there are no interfaces at all", () => {
    const mockInterfaces = () => ({});

    expect(getLocalIpAddress(mockInterfaces)).toBeNull();
  });
});