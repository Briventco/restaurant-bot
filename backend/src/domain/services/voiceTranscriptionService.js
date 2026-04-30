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
    const extension = mimeType.includes("ogg")
      ? "ogg"
      : mimeType.includes("mpeg")
        ? "mp3"
        : mimeType.includes("mp4")
          ? "mp4"
          : "wav";
    const filename = media.filename || `voice-note.${extension}`;
    const audioBuffer = Buffer.from(String(media.data || ""), "base64");

    const file = await OpenAI.toFile(audioBuffer, filename, {
      type: mimeType,
    });
    const result = await openai.audio.transcriptions.create({
      file,
      model,
    });

    const transcript = String((result && result.text) || "").trim();
    return transcript || null;
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

  return {
    isEnabled: Boolean(enabled && openai),
    isAudioMessage,
    transcribeOrNull,
  };
}

module.exports = {
  createVoiceTranscriptionService,
};
