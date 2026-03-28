function toMb(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round((value / (1024 * 1024)) * 100) / 100;
}

function getProcessMemorySnapshot() {
  const usage = process.memoryUsage();
  return {
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssBytes: Number(usage.rss || 0),
    rssMb: toMb(usage.rss),
    heapTotalBytes: Number(usage.heapTotal || 0),
    heapTotalMb: toMb(usage.heapTotal),
    heapUsedBytes: Number(usage.heapUsed || 0),
    heapUsedMb: toMb(usage.heapUsed),
    externalBytes: Number(usage.external || 0),
    externalMb: toMb(usage.external),
    arrayBuffersBytes: Number(usage.arrayBuffers || 0),
    arrayBuffersMb: toMb(usage.arrayBuffers),
  };
}

module.exports = {
  getProcessMemorySnapshot,
};
