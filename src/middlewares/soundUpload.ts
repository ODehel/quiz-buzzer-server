import Busboy from "busboy";
import { AppError } from "../errors/AppError.ts";
import type { AppRequest, SoundMultipartResult } from "../types/index.ts";

const ALLOWED_AUDIO_MIMES: Set<string> = new Set(["audio/mpeg", "audio/wav", "audio/ogg"]);

const MAX_FILE_SIZE: number = 10 * 1024 * 1024; // 10 MB

/**
 * Parses multipart/form-data for sound upload.
 * Expects fields: 'name' (text) and 'file' (audio file).
 */
export function parseSoundFormData(req: AppRequest): Promise<SoundMultipartResult> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_SIZE } });
    let nameField: string | null = null;
    let fileField: string | null = null;
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
      if (fieldname === "name") {
        nameField = val;
      }
    });

    bb.on("close", () => {
      try {
        // CA-8: File size limit
        if (fileTruncated) {
          throw new AppError(413, "FILE_TOO_LARGE", "File size exceeds the 10MB limit.");
        }

        // CA-5: file field required
        if (!fileField) {
          throw new AppError(400, "VALIDATION_ERROR", "The 'file' field is required in the multipart form.");
        }

        // CA-6: name field required
        if (nameField === null || nameField === undefined) {
          throw new AppError(400, "VALIDATION_ERROR", "The 'name' field is required in the multipart form.");
        }

        // CA-7: MIME type validation
        if (!ALLOWED_AUDIO_MIMES.has(fileMimetype!)) {
          throw new AppError(
            400,
            "INVALID_MEDIA_TYPE",
            "File MIME type is not allowed for the declared media type."
          );
        }

        resolve({
          name: nameField,
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
