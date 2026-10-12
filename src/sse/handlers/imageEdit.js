import { handleImageRequestBody } from "./imageGeneration.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

// OpenAI /v1/images/edits accepts up to 16 input images; each must be < 50MB.
export const MAX_EDIT_IMAGES = 16;
export const MAX_EDIT_IMAGE_BYTES = 50 * 1024 * 1024;

const IMAGE_FIELDS = new Set(["image", "image[]"]);
const STRING_FIELDS = ["model", "prompt", "size", "quality", "background", "output_format", "image_detail", "response_format", "user"];

async function blobToDataUrl(blob) {
  const type = blob.type && blob.type.startsWith("image/") ? blob.type : "image/png";
  const b64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
  return `data:${type};base64,${b64}`;
}

function asImageRef(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (/^data:image\//i.test(v) || /^https?:\/\//i.test(v)) return v;
  return null;
}

/**
 * Translate an OpenAI /v1/images/edits request (multipart or JSON) into the
 * image-generation body shape, where reference images go in `images`.
 * Returns { body } or { error: Response }.
 */
export async function parseImageEditRequest(request) {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  const body = {};
  const images = [];

  if (contentType.includes("multipart/form-data")) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data") };
    }
    for (const [key, value] of form.entries()) {
      if (IMAGE_FIELDS.has(key)) {
        if (typeof value === "string") {
          const ref = asImageRef(value);
          if (!ref) return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "image must be a file, data URL, or http(s) URL") };
          images.push(ref);
        } else {
          if (value.size > MAX_EDIT_IMAGE_BYTES) return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "image exceeds 50MB") };
          images.push(await blobToDataUrl(value));
        }
      } else if (key === "mask") {
        // Codex image tool has no mask input; the prompt must describe the region instead.
        body._maskIgnored = true;
      } else if (key === "n") {
        const n = Number(value);
        if (Number.isFinite(n)) body.n = n;
      } else if (STRING_FIELDS.includes(key) && typeof value === "string") {
        body[key] = value;
      }
    }
  } else {
    let json;
    try {
      json = await request.json();
    } catch {
      return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Expected multipart/form-data or JSON body") };
    }
    Object.assign(body, json);
    delete body.image;
    delete body.images;
    delete body.mask;
    const raw = [json.image, ...(Array.isArray(json.images) ? json.images : [])].flat().filter(Boolean);
    for (const item of raw) {
      const ref = asImageRef(typeof item === "string" ? item : item?.image_url || item?.url);
      if (!ref) return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "image must be a data URL or http(s) URL") };
      images.push(ref);
    }
  }

  if (images.length === 0) return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: image") };
  if (images.length > MAX_EDIT_IMAGES) return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, `Too many images (max ${MAX_EDIT_IMAGES})`) };

  delete body._maskIgnored;
  body.images = images;
  return { body };
}

/**
 * POST /v1/images/edits: OpenAI-compatible image edit.
 * Reuses the generations pipeline; providers that accept reference images
 * (Codex GPT Image -> action "edit", Gemini/Antigravity, etc.) handle `images`.
 * @param {Request} request
 */
export async function handleImageEdit(request) {
  const { body, error } = await parseImageEditRequest(request);
  if (error) return error;
  return handleImageRequestBody(request, body);
}
