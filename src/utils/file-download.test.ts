import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  downloadAndUploadFiles,
  type ChannelFileRef,
} from "./file-download";

describe("downloadAndUploadFiles", () => {
  let mockBucket: R2Bucket;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockBucket = { put: vi.fn() } as unknown as R2Bucket;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("downloads a PDF and uploads to R2 with correct .pdf extension", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(pdfBytes, {
        status: 200,
        headers: { "Content-Length": "4", "Content-Type": "application/pdf" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const refs: ChannelFileRef[] = [
      {
        downloadUrl: "https://example.com/report.pdf",
        mediaType: "application/pdf",
        fileName: "report.pdf",
      },
    ];

    const results = await downloadAndUploadFiles(refs, mockBucket, "bot-1");

    expect(results).toHaveLength(1);
    expect(results[0].mediaType).toBe("application/pdf");
    expect(results[0].r2Key).toMatch(/^media\/bot-1\/\d+_[a-f0-9]{8}\.pdf$/);
    expect(results[0].fileName).toBe("report.pdf");
    expect(results[0].sizeBytes).toBe(4);
    expect(results[0].id).toMatch(/^[a-f0-9]{8}$/);
    expect(mockBucket.put).toHaveBeenCalledOnce();
  });

  it("downloads an image (backward compat) with correct .png extension", async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(imageBytes, {
        status: 200,
        headers: { "Content-Length": "4", "Content-Type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const refs: ChannelFileRef[] = [
      {
        downloadUrl: "https://example.com/photo.png",
        mediaType: "image/png",
      },
    ];

    const results = await downloadAndUploadFiles(refs, mockBucket, "bot-1");

    expect(results).toHaveLength(1);
    expect(results[0].mediaType).toBe("image/png");
    expect(results[0].r2Key).toMatch(/^media\/bot-1\/\d+_[a-f0-9]{8}\.png$/);
    expect(results[0].r2Key.startsWith("/")).toBe(false);
    expect(mockBucket.put).toHaveBeenCalledOnce();
  });

  it("downloads a text file", async () => {
    const textBytes = new TextEncoder().encode("Hello, world!");
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(textBytes, {
        status: 200,
        headers: { "Content-Length": String(textBytes.byteLength) },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const refs: ChannelFileRef[] = [
      {
        downloadUrl: "https://example.com/notes.txt",
        mediaType: "text/plain",
        fileName: "notes.txt",
      },
    ];

    const results = await downloadAndUploadFiles(refs, mockBucket, "bot-1");

    expect(results).toHaveLength(1);
    expect(results[0].mediaType).toBe("text/plain");
    expect(results[0].r2Key).toMatch(/^media\/bot-1\/\d+_[a-f0-9]{8}\.txt$/);
    expect(results[0].sizeBytes).toBe(textBytes.byteLength);
    expect(mockBucket.put).toHaveBeenCalledOnce();
  });

  it("skips files exceeding 20MB via Content-Length header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array(0), {
        status: 200,
        headers: {
          "Content-Length": String(21 * 1024 * 1024),
          "Content-Type": "application/pdf",
        },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const refs: ChannelFileRef[] = [
      {
        downloadUrl: "https://example.com/huge.pdf",
        mediaType: "application/pdf",
      },
    ];

    const results = await downloadAndUploadFiles(refs, mockBucket, "bot-1");

    expect(results).toHaveLength(0);
    expect(mockBucket.put).not.toHaveBeenCalled();
  });

  it("skips files exceeding 20MB via actual body size", async () => {
    // Content-Length header is absent/wrong, but actual body exceeds limit
    const hugeBuffer = new Uint8Array(21 * 1024 * 1024);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(hugeBuffer, {
        status: 200,
        // No Content-Length header
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const refs: ChannelFileRef[] = [
      {
        downloadUrl: "https://example.com/huge-no-header.bin",
        mediaType: "application/octet-stream",
      },
    ];

    const results = await downloadAndUploadFiles(refs, mockBucket, "bot-1");

    expect(results).toHaveLength(0);
    expect(mockBucket.put).not.toHaveBeenCalled();
  });

  it("resolves Telegram file_id and downloads via two-step process", async () => {
    const fileBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === "https://api.telegram.org/bot123456:ABC/getFile") {
        return new Response(
          JSON.stringify({
            ok: true,
            result: { file_path: "photos/file_42.jpg" },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (
        url ===
        "https://api.telegram.org/file/bot123456:ABC/photos/file_42.jpg"
      ) {
        return new Response(fileBytes, {
          status: 200,
          headers: { "Content-Length": "4" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const refs: ChannelFileRef[] = [
      {
        downloadUrl: "__telegram_file_id__:AgACAgIAAxkB",
        mediaType: "image/jpeg",
      },
    ];

    const results = await downloadAndUploadFiles(
      refs,
      mockBucket,
      "bot-1",
      "123456:ABC",
    );

    expect(results).toHaveLength(1);
    expect(results[0].mediaType).toBe("image/jpeg");
    expect(results[0].r2Key).toMatch(
      /^media\/bot-1\/\d+_[a-f0-9]{8}\.jpeg$/,
    );

    // First call: getFile API
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456:ABC/getFile",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: "AgACAgIAAxkB" }),
      },
    );

    // Second call: download the resolved file
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/file/bot123456:ABC/photos/file_42.jpg",
      { headers: {} },
    );
  });

  it("skips Telegram file_id when no channelToken is provided", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const refs: ChannelFileRef[] = [
      {
        downloadUrl: "__telegram_file_id__:AgACAgIAAxkB",
        mediaType: "image/jpeg",
      },
    ];

    const results = await downloadAndUploadFiles(refs, mockBucket, "bot-1");

    expect(results).toHaveLength(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("passes auth header when provided (Slack)", async () => {
    const fileBytes = new Uint8Array([0xff, 0xd8, 0xff]);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(fileBytes, {
        status: 200,
        headers: { "Content-Length": "3" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const refs: ChannelFileRef[] = [
      {
        downloadUrl: "https://files.slack.com/photo.jpg",
        authHeader: "Bearer xoxb-slack-token",
        mediaType: "image/jpeg",
      },
    ];

    const results = await downloadAndUploadFiles(refs, mockBucket, "bot-1");

    expect(results).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledWith("https://files.slack.com/photo.jpg", {
      headers: { Authorization: "Bearer xoxb-slack-token" },
    });
  });

  it("skips failed downloads gracefully (404)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const refs: ChannelFileRef[] = [
      {
        downloadUrl: "https://example.com/missing.pdf",
        mediaType: "application/pdf",
      },
    ];

    const results = await downloadAndUploadFiles(refs, mockBucket, "bot-1");

    expect(results).toHaveLength(0);
    expect(mockBucket.put).not.toHaveBeenCalled();
  });

  it("skips when fetch throws an error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    vi.stubGlobal("fetch", mockFetch);

    const refs: ChannelFileRef[] = [
      {
        downloadUrl: "https://example.com/broken.png",
        mediaType: "image/png",
      },
    ];

    const results = await downloadAndUploadFiles(refs, mockBucket, "bot-1");

    expect(results).toHaveLength(0);
    expect(mockBucket.put).not.toHaveBeenCalled();
  });

  it("handles mixed success/failure refs", async () => {
    const fileBytes = new Uint8Array([1, 2, 3]);
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("good.png")) {
        return new Response(fileBytes, {
          status: 200,
          headers: { "Content-Length": "3" },
        });
      }
      if (url.includes("good.pdf")) {
        return new Response(fileBytes, {
          status: 200,
          headers: { "Content-Length": "3" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });
    vi.stubGlobal("fetch", mockFetch);

    const refs: ChannelFileRef[] = [
      { downloadUrl: "https://example.com/good.png", mediaType: "image/png" },
      { downloadUrl: "https://example.com/bad.png", mediaType: "image/png" },
      { downloadUrl: "https://example.com/good.pdf", mediaType: "application/pdf", fileName: "report.pdf" },
    ];

    const results = await downloadAndUploadFiles(refs, mockBucket, "bot-1");

    expect(results).toHaveLength(2);
    expect(results[0].r2Key).toMatch(/\.png$/);
    expect(results[1].r2Key).toMatch(/\.pdf$/);
    expect(results[1].fileName).toBe("report.pdf");
  });

  it("uses filename extension fallback for unknown MIME types", async () => {
    const fileBytes = new Uint8Array([1, 2, 3, 4]);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(fileBytes, {
        status: 200,
        headers: { "Content-Length": "4" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const refs: ChannelFileRef[] = [
      {
        downloadUrl: "https://example.com/report.xlsx",
        mediaType: "application/octet-stream",
        fileName: "report.xlsx",
      },
    ];

    const results = await downloadAndUploadFiles(refs, mockBucket, "bot-1");

    expect(results).toHaveLength(1);
    expect(results[0].r2Key).toMatch(/\.xlsx$/);
    expect(results[0].fileName).toBe("report.xlsx");
  });

  it('returns "bin" extension for completely unknown types without fileName', async () => {
    const fileBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(fileBytes, {
        status: 200,
        headers: { "Content-Length": "4" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const refs: ChannelFileRef[] = [
      {
        downloadUrl: "https://example.com/mystery",
        mediaType: "application/x-unknown-thing",
      },
    ];

    const results = await downloadAndUploadFiles(refs, mockBucket, "bot-1");

    expect(results).toHaveLength(1);
    expect(results[0].r2Key).toMatch(/\.bin$/);
  });
});
