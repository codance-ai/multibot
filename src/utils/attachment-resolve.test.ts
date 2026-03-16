import { describe, it, expect, vi } from "vitest";
import type { AttachmentRef } from "../channels/registry";
import {
  resolveAttachmentsForLLM,
  getAttachmentMetadataText,
  sanitizeFileName,
  type ContentPart,
  type ResolvedAttachments,
} from "./attachment-resolve";

function makeBucket(data: Record<string, Uint8Array>): R2Bucket {
  return {
    get: vi.fn().mockImplementation(async (key: string) => {
      const bytes = data[key];
      if (!bytes) return null;
      return { arrayBuffer: async () => bytes.buffer } as R2ObjectBody;
    }),
  } as unknown as R2Bucket;
}

function makeAttachment(
  overrides: Partial<AttachmentRef> & { mediaType: string; r2Key: string },
): AttachmentRef {
  return {
    id: "test-id",
    r2Key: overrides.r2Key,
    mediaType: overrides.mediaType,
    ...overrides,
  };
}

const encoder = new TextEncoder();

describe("resolveAttachmentsForLLM", () => {
  it("resolves image/png as ImagePart", async () => {
    const pixels = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const bucket = makeBucket({ "media/img.png": pixels });
    const att = makeAttachment({
      r2Key: "media/img.png",
      mediaType: "image/png",
      fileName: "photo.png",
    });

    const result = await resolveAttachmentsForLLM([att], bucket);

    expect(result.contentParts).toHaveLength(1);
    const part = result.contentParts[0] as Extract<ContentPart, { type: "image" }>;
    expect(part.type).toBe("image");
    expect(part.image).toEqual(pixels);
    expect(part.mediaType).toBe("image/png");
    expect(result.metadataText).toBeUndefined();
  });

  it("resolves application/pdf as FilePart", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const bucket = makeBucket({ "media/doc.pdf": pdfBytes });
    const att = makeAttachment({
      r2Key: "media/doc.pdf",
      mediaType: "application/pdf",
      fileName: "report.pdf",
    });

    const result = await resolveAttachmentsForLLM([att], bucket);

    expect(result.contentParts).toHaveLength(1);
    const part = result.contentParts[0] as Extract<ContentPart, { type: "file" }>;
    expect(part.type).toBe("file");
    expect(part.data).toEqual(pdfBytes);
    expect(part.mediaType).toBe("application/pdf");
    expect(result.metadataText).toBeUndefined();
  });

  it("resolves small text/plain as inline TextPart", async () => {
    const textBytes = encoder.encode("hello world");
    const bucket = makeBucket({ "media/notes.txt": textBytes });
    const att = makeAttachment({
      r2Key: "media/notes.txt",
      mediaType: "text/plain",
      fileName: "notes.txt",
    });

    const result = await resolveAttachmentsForLLM([att], bucket);

    expect(result.contentParts).toHaveLength(1);
    const part = result.contentParts[0] as Extract<ContentPart, { type: "text" }>;
    expect(part.type).toBe("text");
    expect(part.text).toBe("[File: notes.txt]\nhello world");
    expect(result.metadataText).toBeUndefined();
  });

  it("resolves small application/json as inline TextPart", async () => {
    const jsonBytes = encoder.encode('{"key":"value"}');
    const bucket = makeBucket({ "media/data.json": jsonBytes });
    const att = makeAttachment({
      r2Key: "media/data.json",
      mediaType: "application/json",
      fileName: "data.json",
    });

    const result = await resolveAttachmentsForLLM([att], bucket);

    expect(result.contentParts).toHaveLength(1);
    const part = result.contentParts[0] as Extract<ContentPart, { type: "text" }>;
    expect(part.type).toBe("text");
    expect(part.text).toBe('[File: data.json]\n{"key":"value"}');
  });

  it("puts large text file into metadata only", async () => {
    const bigContent = new Uint8Array(60 * 1024); // 60 KB, exceeds 50 KB limit
    bigContent.fill(0x61); // fill with 'a'
    const bucket = makeBucket({ "media/big.txt": bigContent });
    const att = makeAttachment({
      r2Key: "media/big.txt",
      mediaType: "text/plain",
      fileName: "big.txt",
      sizeBytes: 60 * 1024,
    });

    const result = await resolveAttachmentsForLLM([att], bucket);

    expect(result.contentParts).toHaveLength(0);
    expect(result.metadataText).toBe(
      "[Attached: big.txt (60.0 KB), type: text/plain]",
    );
  });

  it("puts unsupported type into metadata only", async () => {
    const binBytes = new Uint8Array([0x00, 0x01, 0x02]);
    const bucket = makeBucket({ "media/data.bin": binBytes });
    const att = makeAttachment({
      r2Key: "media/data.bin",
      mediaType: "application/octet-stream",
      fileName: "data.bin",
    });

    const result = await resolveAttachmentsForLLM([att], bucket);

    expect(result.contentParts).toHaveLength(0);
    expect(result.metadataText).toBe(
      "[Attached: data.bin, type: application/octet-stream]",
    );
  });

  it("skips silently when R2 returns null", async () => {
    const bucket = makeBucket({}); // no objects
    const att = makeAttachment({
      r2Key: "media/missing.png",
      mediaType: "image/png",
    });

    const result = await resolveAttachmentsForLLM([att], bucket);

    expect(result.contentParts).toHaveLength(0);
    expect(result.metadataText).toBeUndefined();
  });

  it("skips silently when R2 read throws", async () => {
    const bucket = {
      get: vi.fn().mockRejectedValue(new Error("R2 down")),
    } as unknown as R2Bucket;
    const att = makeAttachment({
      r2Key: "media/fail.png",
      mediaType: "image/png",
    });

    const result = await resolveAttachmentsForLLM([att], bucket);

    expect(result.contentParts).toHaveLength(0);
    expect(result.metadataText).toBeUndefined();
  });

  it("handles mixed attachments correctly", async () => {
    const imgBytes = new Uint8Array([0x89, 0x50]);
    const pdfBytes = new Uint8Array([0x25, 0x50]);
    const xlsBytes = new Uint8Array([0xd0, 0xcf]);
    const bucket = makeBucket({
      "media/photo.jpg": imgBytes,
      "media/doc.pdf": pdfBytes,
      "media/sheet.xlsx": xlsBytes,
    });
    const attachments: AttachmentRef[] = [
      makeAttachment({
        id: "1",
        r2Key: "media/photo.jpg",
        mediaType: "image/jpeg",
        fileName: "photo.jpg",
      }),
      makeAttachment({
        id: "2",
        r2Key: "media/doc.pdf",
        mediaType: "application/pdf",
        fileName: "doc.pdf",
      }),
      makeAttachment({
        id: "3",
        r2Key: "media/sheet.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        fileName: "sheet.xlsx",
        sizeBytes: 2_400_000,
      }),
    ];

    const result = await resolveAttachmentsForLLM(attachments, bucket);

    expect(result.contentParts).toHaveLength(2);
    expect(result.contentParts[0].type).toBe("image");
    expect(result.contentParts[1].type).toBe("file");
    expect(result.metadataText).toBe(
      "[Attached: sheet.xlsx (2.3 MB), type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet]",
    );
  });

  it("returns empty result for empty attachments array", async () => {
    const bucket = makeBucket({});

    const result = await resolveAttachmentsForLLM([], bucket);

    expect(result.contentParts).toHaveLength(0);
    expect(result.metadataText).toBeUndefined();
  });

  it("uses mediaType as label when fileName is absent", async () => {
    const textBytes = encoder.encode("content");
    const bucket = makeBucket({ "media/file.txt": textBytes });
    const att = makeAttachment({
      r2Key: "media/file.txt",
      mediaType: "text/plain",
      // no fileName
    });

    const result = await resolveAttachmentsForLLM([att], bucket);

    expect(result.contentParts).toHaveLength(1);
    const part = result.contentParts[0] as Extract<ContentPart, { type: "text" }>;
    expect(part.text).toBe("[File: text/plain]\ncontent");
  });

  it("omits size in metadata when sizeBytes is absent", async () => {
    const binBytes = new Uint8Array([0x00]);
    const bucket = makeBucket({ "media/blob": binBytes });
    const att = makeAttachment({
      r2Key: "media/blob",
      mediaType: "application/octet-stream",
      fileName: "blob.dat",
      // no sizeBytes
    });

    const result = await resolveAttachmentsForLLM([att], bucket);

    expect(result.metadataText).toBe(
      "[Attached: blob.dat, type: application/octet-stream]",
    );
  });

  it("populates sandboxFiles for every successfully-fetched attachment", async () => {
    const imgBytes = new Uint8Array([0x89, 0x50]);
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const bucket = makeBucket({
      "media/photo.jpg": imgBytes,
      "media/doc.pdf": pdfBytes,
    });
    const attachments: AttachmentRef[] = [
      makeAttachment({ id: "a1", r2Key: "media/photo.jpg", mediaType: "image/jpeg", fileName: "photo.jpg" }),
      makeAttachment({ id: "a2", r2Key: "media/doc.pdf", mediaType: "application/pdf", fileName: "report.pdf" }),
    ];

    const result = await resolveAttachmentsForLLM(attachments, bucket);

    expect(result.sandboxFiles).toHaveLength(2);
    expect(result.sandboxFiles[0].path).toBe("/tmp/attachments/a1_photo.jpg");
    expect(result.sandboxFiles[0].data).toEqual(imgBytes);
    expect(result.sandboxFiles[0].mediaType).toBe("image/jpeg");
    expect(result.sandboxFiles[0].sizeBytes).toBe(2);
    expect(result.sandboxFiles[1].path).toBe("/tmp/attachments/a2_report.pdf");
    expect(result.sandboxFiles[1].data).toEqual(pdfBytes);
  });

  it("sandboxFiles uses sanitized fileName and falls back to mediaType", async () => {
    const bytes = new Uint8Array([0x01]);
    const bucket = makeBucket({ "media/bin": bytes });
    const att = makeAttachment({
      id: "b1",
      r2Key: "media/bin",
      mediaType: "application/octet-stream",
      // no fileName
    });

    const result = await resolveAttachmentsForLLM([att], bucket);

    expect(result.sandboxFiles).toHaveLength(1);
    expect(result.sandboxFiles[0].path).toBe("/tmp/attachments/b1_application_octet-stream");
  });

  it("sandboxFiles is empty when R2 returns null", async () => {
    const bucket = makeBucket({});
    const att = makeAttachment({ r2Key: "media/missing.pdf", mediaType: "application/pdf" });

    const result = await resolveAttachmentsForLLM([att], bucket);

    expect(result.sandboxFiles).toHaveLength(0);
  });

  it("sandboxFiles is empty for empty attachments array", async () => {
    const bucket = makeBucket({});

    const result = await resolveAttachmentsForLLM([], bucket);

    expect(result.sandboxFiles).toHaveLength(0);
  });
});

describe("getAttachmentMetadataText", () => {
  it("generates metadata for unsupported file types", () => {
    const attachments: AttachmentRef[] = [
      makeAttachment({ r2Key: "media/file.zip", mediaType: "application/zip", fileName: "archive.zip", sizeBytes: 2_500_000 }),
    ];
    expect(getAttachmentMetadataText(attachments)).toBe(
      "[Attached: archive.zip (2.4 MB), type: application/zip]",
    );
  });

  it("skips images and PDFs (handled as content parts)", () => {
    const attachments: AttachmentRef[] = [
      makeAttachment({ r2Key: "media/img.png", mediaType: "image/png" }),
      makeAttachment({ r2Key: "media/doc.pdf", mediaType: "application/pdf" }),
    ];
    expect(getAttachmentMetadataText(attachments)).toBeUndefined();
  });

  it("skips small text files (handled as inline text)", () => {
    const attachments: AttachmentRef[] = [
      makeAttachment({ r2Key: "media/data.csv", mediaType: "text/csv", sizeBytes: 1024 }),
    ];
    expect(getAttachmentMetadataText(attachments)).toBeUndefined();
  });

  it("generates metadata for oversized text files", () => {
    const attachments: AttachmentRef[] = [
      makeAttachment({ r2Key: "media/big.txt", mediaType: "text/plain", fileName: "big.txt", sizeBytes: 60 * 1024 }),
    ];
    expect(getAttachmentMetadataText(attachments)).toBe(
      "[Attached: big.txt (60.0 KB), type: text/plain]",
    );
  });

  it("handles mixed supported and unsupported attachments", () => {
    const attachments: AttachmentRef[] = [
      makeAttachment({ r2Key: "media/img.png", mediaType: "image/png" }),
      makeAttachment({ r2Key: "media/file.zip", mediaType: "application/zip", fileName: "project.zip", sizeBytes: 5_000_000 }),
      makeAttachment({ r2Key: "media/data.csv", mediaType: "text/csv", sizeBytes: 1024 }),
    ];
    expect(getAttachmentMetadataText(attachments)).toBe(
      "[Attached: project.zip (4.8 MB), type: application/zip]",
    );
  });

  it("returns undefined for empty array", () => {
    expect(getAttachmentMetadataText([])).toBeUndefined();
  });
});

describe("sanitizeFileName", () => {
  it("replaces path separators with underscores", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("etc_passwd");
  });

  it("replaces shell-unsafe characters", () => {
    expect(sanitizeFileName('file<name>:with|"bad*chars?.txt')).toBe("file_name_with_bad_chars_.txt");
  });

  it("removes control characters", () => {
    expect(sanitizeFileName("file\x00name\x1f.txt")).toBe("filename.txt");
  });

  it("collapses whitespace to single underscore", () => {
    expect(sanitizeFileName("my   big   file.pdf")).toBe("my_big_file.pdf");
  });

  it("strips leading dots and underscores", () => {
    expect(sanitizeFileName("..hidden_file")).toBe("hidden_file");
    expect(sanitizeFileName("___leading")).toBe("leading");
  });

  it("caps length at 200 chars", () => {
    const longName = "a".repeat(250) + ".pdf";
    expect(sanitizeFileName(longName).length).toBeLessThanOrEqual(200);
  });

  it("returns 'file' for empty string after sanitization", () => {
    expect(sanitizeFileName("///")).toBe("file");
    expect(sanitizeFileName("...")).toBe("file");
  });
});
