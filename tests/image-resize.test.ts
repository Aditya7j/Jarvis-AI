import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  resizeImageForVlm,
  stripDataUrlPrefix,
  VISION_VLM_MAX_DIM,
} from "@/lib/ai/image-resize";

describe("VLM image resize", () => {
  it("downscales a full-res frame to at most the VLM max dimension", async () => {
    const fullRes = await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 3,
        background: { r: 120, g: 80, b: 40 },
      },
    })
      .jpeg()
      .toBuffer();
    const resized = await resizeImageForVlm(fullRes.toString("base64"));
    const meta = await sharp(Buffer.from(resized, "base64")).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(
      VISION_VLM_MAX_DIM
    );
  });

  it("does not upscale a small image", async () => {
    const small = await sharp({
      create: {
        width: 240,
        height: 180,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .jpeg()
      .toBuffer();
    const resized = await resizeImageForVlm(small.toString("base64"));
    const meta = await sharp(Buffer.from(resized, "base64")).metadata();
    expect(meta.width).toBe(240);
    expect(meta.height).toBe(180);
  });

  it("fails soft: undecodable input is returned unchanged", async () => {
    const input = "this-is-not-an-image";
    await expect(resizeImageForVlm(input)).resolves.toBe(input);
  });

  it("strips a data: URL prefix", () => {
    expect(stripDataUrlPrefix("data:image/jpeg;base64,ZmFrZQ==")).toBe(
      "ZmFrZQ=="
    );
    expect(stripDataUrlPrefix("ZmFrZQ==")).toBe("ZmFrZQ==");
  });
});
