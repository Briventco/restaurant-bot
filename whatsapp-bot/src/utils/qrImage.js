const QRCode = require("qrcode");

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPngBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= PNG_HEADER.length &&
    buffer.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)
  );
}

function toBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function tryDecodeDataUrl(value) {
  const match = String(value || "")
    .trim()
    .match(/^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    return null;
  }

  const buffer = Buffer.from(match[1], "base64");
  return isPngBuffer(buffer) ? buffer : null;
}

function tryDecodeRawBase64Png(value) {
  const normalized = String(value || "").replace(/\s+/g, "");
  if (!normalized || normalized.length < 80 || !/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    return null;
  }

  try {
    const buffer = Buffer.from(normalized, "base64");
    return isPngBuffer(buffer) ? buffer : null;
  } catch (_error) {
    return null;
  }
}

async function buildQrPngBuffer(qrPayload) {
  const rawValue = String(qrPayload || "").trim();
  if (!rawValue) {
    throw new Error("QR payload is empty");
  }

  const dataUrlBuffer = tryDecodeDataUrl(rawValue);
  if (dataUrlBuffer) {
    return {
      buffer: dataUrlBuffer,
      source: "data_url_png",
    };
  }

  const base64PngBuffer = tryDecodeRawBase64Png(rawValue);
  if (base64PngBuffer) {
    return {
      buffer: base64PngBuffer,
      source: "base64_png",
    };
  }

  const generated = await QRCode.toBuffer(rawValue, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 480,
  });

  return {
    buffer: generated,
    source: "generated_from_qr_text",
  };
}

async function buildQrImageDataUrl(qrPayload) {
  const { buffer, source } = await buildQrPngBuffer(qrPayload);
  return {
    dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
    source,
  };
}

module.exports = {
  toBoolean,
  buildQrPngBuffer,
  buildQrImageDataUrl,
};
