import fs from "node:fs/promises";
import Busboy from "busboy";
import { AppError } from "../errors/AppError.ts";
import { AppRequest, MultipartResult } from "../types/index.ts";

// Supported MIME types per media type
const SUPPORTED_MIMES: Record<string, Set<string>> = {
  image: new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  audio: new Set(["audio/mpeg", "audio/wav", "audio/wave", "audio/ogg"]),
};

// Extension mapping for MIME types
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/wave": ".wav",
  "audio/ogg": ".ogg",
};

const MAX_FILE_SIZE: number = 10 * 1024 * 1024; // 10 MB

/**
 * Creates an upload directory if it doesn't exist
 */
export async function ensureUploadsDirectory(uploadsDir: string): Promise<void> {
  try {
    await fs.mkdir(uploadsDir, { recursive: true });
  } catch (err: unknown) {
    console.error(`Failed to create uploads directory: ${(err as Error).message}`);
  }
}

/**
 * Validates if the MIME type matches the declared media type
 */
function validateMimeTypeMatch(mimeType: string, mediaType: string): void {
  if (!SUPPORTED_MIMES[mediaType]?.has(mimeType)) {
    throw new AppError(
      400,
      "INVALID_MEDIA_TYPE",
      `File MIME type '${mimeType}' does not match declared media type '${mediaType}'.`
    );
  }
}

/**
 * Parses multipart/form-data from request and validates file upload
 */
export async function parseMultipartFormData(req: AppRequest): Promise<MultipartResult> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE } });
    let fileField: string | null = null;
    let typeField: string | null = null;
    let fileBuffer: Buffer | null = null;
    let fileMimetype: string | null = null;
    let fileSize: number = 0;
    let fileTruncated: boolean = false;

    bb.on("file", (fieldname: string, file: NodeJS.ReadableStream, info: { mimeType: string }) => {
      if (fieldname === "file") {
        fileField = fieldname;
        fileMimetype = info.mimeType;

        const chunks: Buffer[] = [];
        file.on("data", (data: Buffer) => {
          chunks.push(data);
          fileSize += data.length;
        });

        file.on("limit", () => {
          fileTruncated = true;
        });

        file.on("end", () => {
          if (!fileTruncated) {
            fileBuffer = Buffer.concat(chunks);
          }
        });

        file.on("error", (err: Error) => {
          reject(err);
        });
      }
    });

    bb.on("field", (fieldname: string, val: string) => {
      if (fieldname === "type") {
        typeField = val;
      }
    });

    bb.on("close", () => {
      try {
        // Check file size limit (truncation by Busboy limits)
        if (fileTruncated) {
          throw new AppError(413, "FILE_TOO_LARGE", "File size exceeds the 10MB limit.");
        }

        // Validate file field
        if (!fileField) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "The 'file' field is required in the multipart form."
          );
        }

        // Validate type field
        if (!typeField) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "The 'type' field is required in the multipart form."
          );
        }

        if (!["image", "audio"].includes(typeField)) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "The 'type' field must be either 'image' or 'audio'."
          );
        }

        // Validate MIME type matches declared type
        validateMimeTypeMatch(fileMimetype!, typeField);

        resolve({
          type: typeField,
          file: {
            buffer: fileBuffer!,
            mimetype: fileMimetype!,
            size: fileSize,
          },
        });
      } catch (err) {
        reject(err);
      }
    });

    bb.on("error", (err: Error) => {
      reject(err);
    });

    req.pipe(bb);
  });
}

/**
 * Gets file extension from MIME type
 */
export function getExtensionFromMime(mimeType: string): string {
  return MIME_TO_EXT[mimeType] || ".bin";
}

/**
 * Checks if a media type is valid
 */
export function isValidMediaType(type: string): boolean {
  return ["image", "audio"].includes(type);
}
