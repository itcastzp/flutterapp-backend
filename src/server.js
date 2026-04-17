import "dotenv/config";
import express from "express";
import { Client as MinioClient } from "minio";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json());

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime"
]);
const maxFileSizeBytes = Number(process.env.MAX_FILE_SIZE_BYTES || 1000 * 1024 * 1024);
const uploadUrlExpireSeconds = Number(process.env.UPLOAD_URL_EXPIRE_SECONDS || 600);
const bucketName = process.env.MINIO_BUCKET || "mobile-images";
const multipartThresholdBytes = Number(process.env.MULTIPART_THRESHOLD_BYTES || 20 * 1024 * 1024);
const multipartPartSizeBytes = Math.max(
  Number(process.env.MULTIPART_PART_SIZE_BYTES || 8 * 1024 * 1024),
  5 * 1024 * 1024
);

const minioClient = new MinioClient({
  endPoint: process.env.MINIO_ENDPOINT || "127.0.0.1",
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: String(process.env.MINIO_USE_SSL || "false").toLowerCase() === "true",
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY
});

function sanitizeFileName(fileName) {
  return String(fileName || "image.jpg")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
}

function objectKeyFor(userId, fileName) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${userId}/${yyyy}/${mm}/${dd}/${randomUUID()}_${sanitizeFileName(fileName)}`;
}

async function ensureBucketExists() {
  const exists = await minioClient.bucketExists(bucketName);
  if (!exists) {
    await minioClient.makeBucket(bucketName);
  }
}

function validateUploadInput(fileName, contentType, fileSize) {
  if (!fileName || !contentType || typeof fileSize !== "number") {
    return {
      ok: false,
      status: 400,
      body: {
        code: "INVALID_ARGUMENTS",
        message: "fileName, contentType, fileSize are required"
      }
    };
  }

  if (!allowedMimeTypes.has(contentType)) {
    return {
      ok: false,
      status: 400,
      body: {
        code: "UNSUPPORTED_FILE_TYPE",
        message: "Only image/jpeg, image/png, image/webp, video/mp4, video/quicktime are allowed"
      }
    };
  }

  if (fileSize <= 0 || fileSize > maxFileSizeBytes) {
    return {
      ok: false,
      status: 400,
      body: {
        code: "FILE_TOO_LARGE",
        message: `Max allowed file size is ${maxFileSizeBytes} bytes`
      }
    };
  }

  return { ok: true };
}

function checkObjectOwner(userId, objectKey) {
  return String(objectKey || "").startsWith(`${userId}/`);
}

app.get("/healthz", async (_req, res) => {
  try {
    await ensureBucketExists();
    res.json({ ok: true, bucket: bucketName });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.post("/api/upload/presign", async (req, res) => {
  try {
    const { fileName, contentType, fileSize } = req.body || {};
    const userId = String(req.header("x-user-id") || "anonymous");
    const validation = validateUploadInput(fileName, contentType, fileSize);

    if (!validation.ok) return res.status(validation.status).json(validation.body);

    await ensureBucketExists();

    const objectKey = objectKeyFor(userId, fileName);
    const reqParams = { "Content-Type": contentType };
    const uploadUrl = await minioClient.presignedPutObject(
      bucketName,
      objectKey,
      uploadUrlExpireSeconds,
      reqParams
    );

    return res.json({
      code: "0",
      message: "success",
      data: {
        bucket: bucketName,
        objectKey,
        uploadUrl,
        expireSeconds: uploadUrlExpireSeconds
      }
    });
  } catch (error) {
    return res.status(500).json({
      code: "PRESIGN_FAILED",
      message: error.message
    });
  }
});

app.post("/api/upload/multipart/init", async (req, res) => {
  try {
    const { fileName, contentType, fileSize } = req.body || {};
    const userId = String(req.header("x-user-id") || "anonymous");
    const validation = validateUploadInput(fileName, contentType, fileSize);
    if (!validation.ok) return res.status(validation.status).json(validation.body);

    await ensureBucketExists();

    const objectKey = objectKeyFor(userId, fileName);
    const uploadId = await minioClient.initiateNewMultipartUpload(bucketName, objectKey, {
      "Content-Type": contentType
    });

    return res.json({
      code: "0",
      message: "success",
      data: {
        bucket: bucketName,
        objectKey,
        uploadId,
        contentType,
        fileSize,
        expireSeconds: uploadUrlExpireSeconds,
        partSizeBytes: multipartPartSizeBytes,
        recommendedPartCount: Math.max(1, Math.ceil(fileSize / multipartPartSizeBytes)),
        useMultipart: fileSize >= multipartThresholdBytes
      }
    });
  } catch (error) {
    return res.status(500).json({
      code: "MULTIPART_INIT_FAILED",
      message: error.message
    });
  }
});

app.post("/api/upload/multipart/sign-part", async (req, res) => {
  try {
    const { objectKey, uploadId, partNumber } = req.body || {};
    const userId = String(req.header("x-user-id") || "anonymous");
    const parsedPartNumber = Number(partNumber);

    if (!objectKey || !uploadId || !Number.isInteger(parsedPartNumber)) {
      return res.status(400).json({
        code: "INVALID_ARGUMENTS",
        message: "objectKey, uploadId, partNumber are required"
      });
    }

    if (parsedPartNumber < 1 || parsedPartNumber > 10000) {
      return res.status(400).json({
        code: "INVALID_PART_NUMBER",
        message: "partNumber must be an integer between 1 and 10000"
      });
    }

    if (!checkObjectOwner(userId, objectKey)) {
      return res.status(403).json({
        code: "FORBIDDEN_OBJECT_KEY",
        message: "objectKey does not belong to current user"
      });
    }

    await ensureBucketExists();

    const uploadUrl = await minioClient.presignedUrl("PUT", bucketName, objectKey, uploadUrlExpireSeconds, {
      partNumber: String(parsedPartNumber),
      uploadId: String(uploadId)
    });

    return res.json({
      code: "0",
      message: "success",
      data: {
        bucket: bucketName,
        objectKey,
        uploadId,
        partNumber: parsedPartNumber,
        uploadUrl,
        expireSeconds: uploadUrlExpireSeconds
      }
    });
  } catch (error) {
    return res.status(500).json({
      code: "MULTIPART_SIGN_PART_FAILED",
      message: error.message
    });
  }
});

app.post("/api/upload/multipart/complete", async (req, res) => {
  try {
    const { objectKey, uploadId, parts } = req.body || {};
    const userId = String(req.header("x-user-id") || "anonymous");

    if (!objectKey || !uploadId || !Array.isArray(parts) || parts.length === 0) {
      return res.status(400).json({
        code: "INVALID_ARGUMENTS",
        message: "objectKey, uploadId, parts are required"
      });
    }

    if (!checkObjectOwner(userId, objectKey)) {
      return res.status(403).json({
        code: "FORBIDDEN_OBJECT_KEY",
        message: "objectKey does not belong to current user"
      });
    }

    const normalizedParts = parts.map((part) => ({
      part: Number(part?.partNumber),
      etag: String(part?.etag || "").replaceAll("\"", "")
    }));

    const hasInvalidPart = normalizedParts.some((part) => !Number.isInteger(part.part) || part.part < 1 || !part.etag);
    if (hasInvalidPart) {
      return res.status(400).json({
        code: "INVALID_PARTS",
        message: "parts must include valid partNumber and etag"
      });
    }

    await ensureBucketExists();

    const result = await minioClient.completeMultipartUpload(bucketName, objectKey, uploadId, normalizedParts);

    return res.json({
      code: "0",
      message: "success",
      data: {
        bucket: bucketName,
        objectKey,
        etag: result.etag,
        versionId: result.versionId
      }
    });
  } catch (error) {
    return res.status(500).json({
      code: "MULTIPART_COMPLETE_FAILED",
      message: error.message
    });
  }
});

app.post("/api/upload/multipart/abort", async (req, res) => {
  try {
    const { objectKey, uploadId } = req.body || {};
    const userId = String(req.header("x-user-id") || "anonymous");

    if (!objectKey || !uploadId) {
      return res.status(400).json({
        code: "INVALID_ARGUMENTS",
        message: "objectKey, uploadId are required"
      });
    }

    if (!checkObjectOwner(userId, objectKey)) {
      return res.status(403).json({
        code: "FORBIDDEN_OBJECT_KEY",
        message: "objectKey does not belong to current user"
      });
    }

    await ensureBucketExists();
    await minioClient.abortMultipartUpload(bucketName, objectKey, uploadId);

    return res.json({
      code: "0",
      message: "success",
      data: { bucket: bucketName, objectKey, uploadId }
    });
  } catch (error) {
    return res.status(500).json({
      code: "MULTIPART_ABORT_FAILED",
      message: error.message
    });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Presign API listening on http://127.0.0.1:${port}`);
});
