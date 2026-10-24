import { describe, expect, it } from "vitest";
import { pcm16ToFloat32 } from "./gemini-live-audio";

describe("Gemini Live audio", () => {
  it("reads 16-bit little-endian PCM as samples in [-1, 1)", () => {
    const pcm = new Int16Array([0, 0x4000, -0x8000, 0x7fff]);
    expect(Array.from(pcm16ToFloat32(pcm.buffer))).toEqual([0, 0.5, -1, 0x7fff / 0x8000]);
  });

  it("ignores a trailing odd byte", () => {
    expect(pcm16ToFloat32(new Uint8Array([0, 0x40, 7]).buffer)).toHaveLength(1);
  });
});
