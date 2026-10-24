import { describe, expect, it } from "vitest";
import { downsample48to16, phoneBridgeConfig, upsample24to48 } from "./live-phone-bridge.ts";

const pcm = (...samples: number[]) => {
  const out = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => out.writeInt16LE(sample, i * 2));
  return out;
};
const samples = (buffer: Buffer) => Array.from({ length: buffer.length / 2 }, (_, i) => buffer.readInt16LE(i * 2));

describe("phone audio", () => {
  it("averages 48 kHz down to 16 kHz", () => {
    expect(samples(downsample48to16(pcm(3, 6, 9, -3, -6, -9, 100)))).toEqual([6, -6]);
  });

  it("interpolates 24 kHz up to 48 kHz across chunks", () => {
    const first = upsample24to48(pcm(100, 200), 0);
    expect(samples(first.pcm)).toEqual([50, 100, 150, 200]);
    expect(samples(upsample24to48(pcm(400), first.last).pcm)).toEqual([300, 400]);
  });
});

describe("phone bridge config", () => {
  it("needs a public IPv4 address, and takes ten ports from 40000 by default", () => {
    expect(phoneBridgeConfig({})).toBeNull();
    expect(phoneBridgeConfig({ OMB_LIVE_PUBLIC_IP: "example.com" })).toBeNull();
    expect(phoneBridgeConfig({ OMB_LIVE_PUBLIC_IP: "300.1.1.1" })).toBeNull();
    expect(phoneBridgeConfig({ OMB_LIVE_PUBLIC_IP: " 203.0.113.7 " })).toEqual({ publicAddress: "203.0.113.7", portRange: [40000, 40009] });
  });

  it("reads a port range and refuses a bad one", () => {
    expect(phoneBridgeConfig({ OMB_LIVE_PUBLIC_IP: "203.0.113.7", OMB_LIVE_UDP_PORTS: "50000-50019" })?.portRange).toEqual([50000, 50019]);
    for (const ports of ["80-90", "50010-50000", "50000", "1-70000"]) {
      expect(phoneBridgeConfig({ OMB_LIVE_PUBLIC_IP: "203.0.113.7", OMB_LIVE_UDP_PORTS: ports }), ports).toBeNull();
    }
  });
});
