function assertAdapter(channel, adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error(`Invalid adapter for ${channel}`);
  }

  if (typeof adapter.sendMessage !== "function") {
    throw new Error(`Adapter ${channel} must implement sendMessage`);
  }
}

class ProviderRegistry {
  constructor() {
    this.adapters = new Map();
  }

  registerAdapter(channel, adapter) {
    const normalizedChannel = String(channel || "").trim();
    if (!normalizedChannel) {
      throw new Error("Channel is required when registering an adapter");
    }

    assertAdapter(normalizedChannel, adapter);
    this.adapters.set(normalizedChannel, adapter);
  }

  getAdapter(channel) {
    const normalizedChannel = String(channel || "").trim();
    const adapter = this.adapters.get(normalizedChannel);
    if (!adapter) {
      const error = new Error(`No provider adapter registered for ${normalizedChannel}`);
      error.statusCode = 400;
      throw error;
    }
    return adapter;
  }

  hasAdapter(channel) {
    const normalizedChannel = String(channel || "").trim();
    return this.adapters.has(normalizedChannel);
  }

  listChannels() {
    return Array.from(this.adapters.keys());
  }
}

module.exports = {
  ProviderRegistry,
};
