import { describe, it, expect, vi } from "vitest";
import { parseImageReferences, stripImageReferences, extractImageReferences, uploadImageToR2, resolveWorkspaceImages, normalizeAssistantReply } from "./media";

describe("parseImageReferences", () => {
  it("extracts a single image reference", () => {
    const text = "Here is a cat!\n![a cute cat](image:/media/bot1/123_abc.png)";
    const refs = parseImageReferences(text);
    expect(refs).toEqual([
      {
        fullMatch: "![a cute cat](image:/media/bot1/123_abc.png)",
        alt: "a cute cat",
        path: "/media/bot1/123_abc.png",
      },
    ]);
  });

  it("extracts multiple image references", () => {
    const text = "![cat](image:/media/b/1.png)\nsome text\n![dog](image:/media/b/2.png)";
    const refs = parseImageReferences(text);
    expect(refs).toHaveLength(2);
    expect(refs[0].alt).toBe("cat");
    expect(refs[1].alt).toBe("dog");
  });

  it("returns empty array when no references", () => {
    expect(parseImageReferences("just plain text")).toEqual([]);
  });

  it("handles empty alt text", () => {
    const refs = parseImageReferences("![](image:/media/b/1.png)");
    expect(refs[0].alt).toBe("");
    expect(refs[0].path).toBe("/media/b/1.png");
  });

  it("handles full URL paths (fallback without R2)", () => {
    const refs = parseImageReferences("![desc](image:https://example.com/img.png)");
    expect(refs[0].path).toBe("https://example.com/img.png");
  });

  it("does not match regular markdown images (no image: prefix)", () => {
    expect(parseImageReferences("![alt](https://example.com/img.png)")).toEqual([]);
  });

  it("does not match LLM-prefixed image refs (handled by orphan cleanup)", () => {
    expect(parseImageReferences("![spicy photo](attachment:image:/workspace/images/abc.png)")).toEqual([]);
    expect(parseImageReferences("![x](file:image:/workspace/images/abc.png)")).toEqual([]);
  });
});

describe("stripImageReferences", () => {
  it("strips all image: markdown refs from text", () => {
    const text = "Here is a cat!\n![a cute cat](image:/media/bot1/123_abc.png)";
    expect(stripImageReferences(text)).toBe("Here is a cat!");
  });

  it("strips multiple image refs", () => {
    const text = "Hello\n![cat](image:/media/b/1.png)\nworld\n![dog](image:/media/b/2.png)";
    expect(stripImageReferences(text)).toBe("Hello\n\nworld");
  });

  it("returns text unchanged when no image refs", () => {
    expect(stripImageReferences("just plain text")).toBe("just plain text");
  });

  it("preserves regular markdown images (no image: prefix)", () => {
    const text = "Check this ![photo](https://example.com/img.png) out";
    expect(stripImageReferences(text)).toBe("Check this ![photo](https://example.com/img.png) out");
  });

  it("cleans up excess whitespace after stripping", () => {
    const text = "Line 1\n\n\n![img](image:/media/b/1.png)\n\n\n\nLine 2";
    expect(stripImageReferences(text)).toBe("Line 1\n\nLine 2");
  });

  it("handles text that is only image refs (returns empty string)", () => {
    const text = "![a](image:/media/b/1.png)\n![b](image:/media/b/2.png)";
    expect(stripImageReferences(text)).toBe("");
  });
});

describe("extractImageReferences", () => {
  it("returns cleaned text and media items", () => {
    const text = "Here is your image!\n![a cat](image:/media/b/1.png)";
    const result = extractImageReferences(text, "https://example.com");
    expect(result.cleanedText).toBe("Here is your image!");
    expect(result.media).toEqual([
      { kind: "image", source: { type: "url", url: "https://example.com/media/b/1.png" } },
    ]);
  });

  it("resolves relative paths with baseUrl", () => {
    const text = "![x](image:/media/b/1.png)";
    const result = extractImageReferences(text, "https://host.com");
    expect(result.media[0].source).toEqual({ type: "url", url: "https://host.com/media/b/1.png" });
  });

  it("keeps full URLs as-is", () => {
    const text = "![x](image:https://provider.com/img.png)";
    const result = extractImageReferences(text, "https://host.com");
    expect(result.media[0].source).toEqual({ type: "url", url: "https://provider.com/img.png" });
  });

  it("handles no baseUrl with relative paths", () => {
    const text = "![x](image:/media/b/1.png)";
    const result = extractImageReferences(text);
    expect(result.media[0].source).toEqual({ type: "url", url: "/media/b/1.png" });
  });

  it("returns original text when no references", () => {
    const text = "just text";
    const result = extractImageReferences(text);
    expect(result.cleanedText).toBe("just text");
    expect(result.media).toEqual([]);
  });

  it("cleans up extra whitespace after removal", () => {
    const text = "Line 1\n\n![img](image:/media/b/1.png)\n\n\nLine 2";
    const result = extractImageReferences(text, "https://host.com");
    expect(result.cleanedText).toBe("Line 1\n\nLine 2");
  });

  it("extracts multiple images", () => {
    const text = "![a](image:/media/b/1.png)\ntext\n![b](image:/media/b/2.png)";
    const result = extractImageReferences(text, "https://h.com");
    expect(result.media).toHaveLength(2);
    expect(result.media[0].source).toEqual({ type: "url", url: "https://h.com/media/b/1.png" });
    expect(result.media[1].source).toEqual({ type: "url", url: "https://h.com/media/b/2.png" });
  });

  it("strips orphaned workspace image references without image: prefix", () => {
    const text = "Here is a selfie!\n![selfie](/workspace/images/abc.png)\n![cat](image:/media/b/1.png)";
    const result = extractImageReferences(text, "https://h.com");
    expect(result.cleanedText).toBe("Here is a selfie!");
    expect(result.media).toHaveLength(1);
    expect(result.media[0].source).toEqual({ type: "url", url: "https://h.com/media/b/1.png" });
  });

  it("strips workspace refs with any prefix (attachment:image:, etc.)", () => {
    const text = "Here comes the photo\n![spicy photo](attachment:image:/workspace/images/abc.png)";
    const result = extractImageReferences(text, "https://h.com");
    expect(result.cleanedText).toBe("Here comes the photo");
    expect(result.media).toEqual([]);
  });

  it("strips workspace refs with arbitrary prefixes", () => {
    const text = "Here!\n![x](file:/workspace/images/abc.png)\n![y](blob:/workspace/images/def.png)";
    const result = extractImageReferences(text);
    expect(result.cleanedText).toBe("Here!");
    expect(result.media).toEqual([]);
  });

  it("only strips workspace paths, preserves other markdown images", () => {
    const text = "Text ![foo](https://example.com/img.png) more text ![bar](/workspace/images/x.png)";
    const result = extractImageReferences(text);
    expect(result.cleanedText).toBe("Text ![foo](https://example.com/img.png) more text");
    expect(result.media).toEqual([]);
  });

  it("strips bare image:/workspace/ refs (non-markdown format)", () => {
    const text = "Here is the photo\n\nimage:/workspace/images/fbb92b08487f.png\n[image]";
    const result = extractImageReferences(text);
    expect(result.cleanedText).toBe("Here is the photo\n\n[image]");
    expect(result.media).toEqual([]);
  });

  it("strips plain /workspace/ path without any prefix", () => {
    const text = "Generated at /workspace/images/abc.png enjoy!";
    const result = extractImageReferences(text);
    expect(result.cleanedText).toBe("Generated at  enjoy!");
    expect(result.media).toEqual([]);
  });

  it("does NOT strip URLs containing /workspace/", () => {
    const text = "Visit https://example.com/workspace/settings for config";
    const result = extractImageReferences(text);
    expect(result.cleanedText).toBe("Visit https://example.com/workspace/settings for config");
  });
});

describe("resolveWorkspaceImages (HTTP upload)", () => {
  it("replaces workspace refs with media paths via curl upload", async () => {
    const text = '![selfie](image:/workspace/images/selfie.png)';
    const execFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ path: "/media/bot1/123_abc.jpeg" }),
    });
    const result = await resolveWorkspaceImages(text, execFn, "https://example.com/upload?token=tok&botId=bot1");
    expect(result).toBe('![selfie](image:/media/bot1/123_abc.jpeg)');
    expect(execFn).toHaveBeenCalledTimes(1);
    const cmd = execFn.mock.calls[0][0];
    expect(cmd).toContain("curl");
    expect(cmd).toContain("--max-time 30");
    expect(cmd).toContain("/workspace/images/selfie.png");
  });

  it("returns text unchanged when no workspace refs", async () => {
    const text = "no images here";
    const execFn = vi.fn();
    const result = await resolveWorkspaceImages(text, execFn, "https://example.com/upload?token=t&botId=b");
    expect(result).toBe(text);
    expect(execFn).not.toHaveBeenCalled();
  });

  it("skips unsafe paths", async () => {
    const text = "![x](image:/workspace/images/../../../etc/passwd)";
    const execFn = vi.fn();
    const result = await resolveWorkspaceImages(text, execFn, "https://example.com/upload?token=t&botId=b");
    expect(result).toBe(text);
    expect(execFn).not.toHaveBeenCalled();
  });

  it("handles multiple images with deduplication", async () => {
    const text = "![a](image:/workspace/images/a.png)\n![b](image:/workspace/images/b.png)\n![a2](image:/workspace/images/a.png)";
    let callCount = 0;
    const execFn = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        stdout: JSON.stringify({ path: `/media/bot1/${callCount}.png` }),
      });
    });
    const result = await resolveWorkspaceImages(text, execFn, "https://example.com/upload?token=t&botId=b");
    expect(execFn).toHaveBeenCalledTimes(2); // 2 unique paths
    expect(result).toContain("image:/media/bot1/1.png");
    expect(result).toContain("image:/media/bot1/2.png");
  });

  it("skips image on upload failure", async () => {
    const text = "![x](image:/workspace/images/fail.png)";
    const execFn = vi.fn().mockRejectedValue(new Error("upload failed"));
    const result = await resolveWorkspaceImages(text, execFn, "https://example.com/upload?token=t&botId=b");
    expect(result).toBe(text);
  });

  it("handles non-JSON upload response gracefully", async () => {
    const text = "![x](image:/workspace/images/bad.png)";
    const execFn = vi.fn().mockResolvedValue({ stdout: "not json" });
    const result = await resolveWorkspaceImages(text, execFn, "https://example.com/upload?token=t&botId=b");
    expect(result).toBe(text);
  });

  it("rejects r2Path that does not start with /media/", async () => {
    const text = "![x](image:/workspace/images/test.png)";
    const execFn = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ path: "/evil/path.png" }),
    });
    const result = await resolveWorkspaceImages(text, execFn, "https://example.com/upload?token=t&botId=b");
    expect(result).toBe(text);
  });

  it("skips /media/ refs (already resolved)", async () => {
    const text = "![x](image:/media/bot1/already.png)";
    const execFn = vi.fn();
    const result = await resolveWorkspaceImages(text, execFn, "https://example.com/upload?token=t&botId=b");
    expect(result).toBe(text);
    expect(execFn).not.toHaveBeenCalled();
  });
});

describe("uploadImageToR2", () => {
  it("uploads and returns relative path", async () => {
    const mockPut = vi.fn().mockResolvedValue(undefined);
    const bucket = { put: mockPut } as unknown as R2Bucket;
    const data = new Uint8Array([1, 2, 3]);

    const path = await uploadImageToR2(bucket, "bot123", data);

    expect(path).toMatch(/^\/media\/bot123\/\d+_[a-f0-9]{8}\.png$/);
    expect(mockPut).toHaveBeenCalledOnce();
    const [key, body, options] = mockPut.mock.calls[0];
    expect(key).toMatch(/^media\/bot123\/\d+_[a-f0-9]{8}\.png$/);
    expect(body).toBe(data);
    expect(options).toEqual({ httpMetadata: { contentType: "image/png" } });
  });

  it("uses provided mediaType for content-type and extension", async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const data = new Uint8Array([0xff, 0xd8, 0xff]);

    const path = await uploadImageToR2(bucket, "bot-123", data, "image/jpeg");

    expect(path).toMatch(/^\/media\/bot-123\/\d+_[a-f0-9]+\.jpeg$/);
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringMatching(/\.jpeg$/),
      data,
      { httpMetadata: { contentType: "image/jpeg" } },
    );
  });

  it("defaults to png when no mediaType provided", async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket;
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    const path = await uploadImageToR2(bucket, "bot-123", data);

    expect(path).toMatch(/\.png$/);
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringMatching(/\.png$/),
      data,
      { httpMetadata: { contentType: "image/png" } },
    );
  });
});

describe("normalizeAssistantReply", () => {
  it("returns text unchanged when no image refs", () => {
    const result = normalizeAssistantReply("just plain text");
    expect(result.text).toBe("just plain text");
    expect(result.attachments).toEqual([]);
  });

  it("extracts image: refs into attachments array and removes placeholder", () => {
    const text = "Here is the photo\n![Photorealistic selfie](image:/media/bot1/123.png)";
    const result = normalizeAssistantReply(text);
    expect(result.text).toBe("Here is the photo");
    expect(result.attachments).toEqual([{ url: "/media/bot1/123.png", alt: "Photorealistic selfie", mediaType: "image/png" }]);
  });

  it("extracts image: refs with generic alt and removes placeholder", () => {
    const text = "Done!\n![image](image:/media/bot1/123.png)";
    const result = normalizeAssistantReply(text);
    expect(result.text).toBe("Done!");
    expect(result.attachments).toHaveLength(1);
  });

  it("extracts image: refs with empty alt and removes placeholder", () => {
    const text = "Here!\n![](image:/media/bot1/123.png)";
    const result = normalizeAssistantReply(text);
    expect(result.text).toBe("Here!");
    expect(result.attachments).toHaveLength(1);
  });

  it("infers mediaType from file extension for image: refs", () => {
    expect(normalizeAssistantReply("![a](image:/media/b/1.jpeg)").attachments[0].mediaType).toBe("image/jpeg");
    expect(normalizeAssistantReply("![a](image:/media/b/1.webp)").attachments[0].mediaType).toBe("image/webp");
    expect(normalizeAssistantReply("![a](image:/media/b/1.gif)").attachments[0].mediaType).toBe("image/gif");
    expect(normalizeAssistantReply("![a](image:/media/b/1.png)").attachments[0].mediaType).toBe("image/png");
    expect(normalizeAssistantReply("![a](image:/media/b/1.bmp)").attachments[0].mediaType).toBe("image/png");
  });

  it("strips plain markdown /media/ refs (NOT into attachments array)", () => {
    const text = "Here\n![image](/media/eb4d5cd8eb8d.png)";
    const result = normalizeAssistantReply(text);
    expect(result.text).toBe("Here");
    expect(result.attachments).toEqual([]);
  });

  it("handles mixed image: and plain /media/ refs correctly", () => {
    const text = "Legs extended version\n![image](/media/eb4d5cd8eb8d.png)\n![Photorealistic selfie](image:/media/bot1/456.png)";
    const result = normalizeAssistantReply(text);
    expect(result.text).toBe("Legs extended version");
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].url).toBe("/media/bot1/456.png");
  });

  it("strips /workspace/ refs entirely (no placeholder, no image)", () => {
    const text = "Check this\n![selfie](/workspace/images/abc.png)";
    const result = normalizeAssistantReply(text);
    expect(result.text).toBe("Check this");
    expect(result.attachments).toEqual([]);
  });

  it("resolves relative paths with baseUrl for image: refs", () => {
    const text = "![cat](image:/media/bot1/1.png)";
    const result = normalizeAssistantReply(text, "https://example.com");
    expect(result.attachments[0].url).toBe("https://example.com/media/bot1/1.png");
  });

  it("keeps full URLs as-is for image: refs", () => {
    const text = "![cat](image:https://provider.com/img.png)";
    const result = normalizeAssistantReply(text, "https://example.com");
    expect(result.attachments[0].url).toBe("https://provider.com/img.png");
  });

  it("handles empty text", () => {
    const result = normalizeAssistantReply("");
    expect(result.text).toBe("");
    expect(result.attachments).toEqual([]);
  });

  it("collapses excess newlines after extraction", () => {
    const text = "Line 1\n\n\n![img](image:/media/b/1.png)\n\n\n\nLine 2";
    const result = normalizeAssistantReply(text);
    expect(result.text).toBe("Line 1\n\nLine 2");
  });

  it("preserves regular markdown images (non-/media/ URLs)", () => {
    const text = "Check ![photo](https://example.com/img.png) out";
    const result = normalizeAssistantReply(text);
    expect(result.text).toBe("Check ![photo](https://example.com/img.png) out");
    expect(result.attachments).toEqual([]);
  });

  it("returns empty text for image-only reply (no text content)", () => {
    const longAlt = "A".repeat(200);
    const text = `![${longAlt}](image:/media/b/1.png)`;
    const result = normalizeAssistantReply(text);
    expect(result.text).toBe("");
  });

  it("strips bare image:/workspace/ refs (non-markdown format)", () => {
    const text = "Here it is, submitting my work\n\nimage:/workspace/images/fbb92b08487f.png";
    const result = normalizeAssistantReply(text);
    expect(result.text).toBe("Here it is, submitting my work");
    expect(result.attachments).toEqual([]);
  });

  it("strips bare /workspace/ path without prefix", () => {
    const text = "Image saved to /workspace/images/abc.png";
    const result = normalizeAssistantReply(text);
    expect(result.text).toBe("Image saved to");
    expect(result.attachments).toEqual([]);
  });

  it("strips workspace paths with arbitrary prefixes", () => {
    const text = "Here\nfile:/workspace/images/x.png\nattachment:/workspace/other/y.png";
    const result = normalizeAssistantReply(text);
    expect(result.text).toBe("Here");
    expect(result.attachments).toEqual([]);
  });

  it("does NOT strip URLs containing /workspace/", () => {
    const text = "See https://docs.example.com/workspace/guide for details";
    const result = normalizeAssistantReply(text);
    expect(result.text).toBe("See https://docs.example.com/workspace/guide for details");
  });
});
