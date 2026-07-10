let OpenAI = null;
try {
  OpenAI = require("openai");
} catch (_error) {
  OpenAI = null;
}

function createVoiceTranscriptionService({
  enabled = false,
  openAIApiKey = "",
  model = "gpt-4o-mini-transcribe",
  logger,
}) {
  const openai =
    enabled && openAIApiKey && OpenAI ? new OpenAI({ apiKey: openAIApiKey }) : null;

  function isAudioMessage(rawEvent) {
    const type = String((rawEvent && rawEvent.type) || "").trim().toLowerCase();
    const mimetype = String(
      (rawEvent && rawEvent._data && rawEvent._data.mimetype) || ""
    )
      .trim()
      .toLowerCase();

    return type === "ptt" || type === "audio" || mimetype.startsWith("audio/");
  }

  function extensionForMimeType(mimeType) {
    const normalized = String(mimeType || "audio/ogg").trim() || "audio/ogg";
    if (normalized.includes("ogg")) return "ogg";
    if (normalized.includes("mpeg")) return "mp3";
    if (normalized.includes("mp4")) return "mp4";
    return "wav";
  }

  async function transcribeBuffer({ buffer, mimeType, filename }) {
    if (!enabled || !openai || !buffer || !buffer.length) {
      return null;
    }

    const effectiveMimeType = String(mimeType || "audio/ogg").trim() || "audio/ogg";
    const effectiveFilename = filename || `voice-note.${extensionForMimeType(effectiveMimeType)}`;

    const file = await OpenAI.toFile(buffer, effectiveFilename, {
      type: effectiveMimeType,
    });
    const result = await openai.audio.transcriptions.create({
      file,
      model,
    });

    const transcript = String((result && result.text) || "").trim();
    return transcript || null;
  }

  async function maybeTranscribeWhatsappMessage(rawEvent) {
    if (!enabled || !openai) {
      return null;
    }

    if (!rawEvent || !rawEvent.hasMedia || typeof rawEvent.downloadMedia !== "function") {
      return null;
    }

    if (!isAudioMessage(rawEvent)) {
      return null;
    }

    const media = await rawEvent.downloadMedia();
    if (!media || !media.data) {
      return null;
    }

    const mimeType = String(media.mimetype || "audio/ogg").trim() || "audio/ogg";
    const audioBuffer = Buffer.from(String(media.data || ""), "base64");

    return transcribeBuffer({ buffer: audioBuffer, mimeType, filename: media.filename });
  }

  async function transcribeOrNull(rawEvent) {
    try {
      return await maybeTranscribeWhatsappMessage(rawEvent);
    } catch (error) {
      logger.warn("Voice transcription failed", {
        message: error && error.message ? error.message : "voice_transcription_failed",
      });
      return null;
    }
  }

  async function transcribeBufferOrNull({ buffer, mimeType, filename }) {
    try {
      return await transcribeBuffer({ buffer, mimeType, filename });
    } catch (error) {
      logger.warn("Voice transcription failed", {
        message: error && error.message ? error.message : "voice_transcription_failed",
      });
      return null;
    }
  }

  return {
    isEnabled: Boolean(enabled && openai),
    isAudioMessage,
    transcribeOrNull,
    transcribeBufferOrNull,
  };
}

module.exports = {
  createVoiceTranscriptionService,
};
