const fs = require("node:fs");
const path = require("node:path");

function toMb(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round((value / (1024 * 1024)) * 100) / 100;
}

function readTextFile(filePath) {
  try {
    return String(fs.readFileSync(filePath, "utf8") || "").trim();
  } catch (_error) {
    return "";
  }
}

function normalizeMemoryLimitBytes(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.toLowerCase() === "max") {
    return 0;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  // cgroup "unlimited" values are often represented as very large integers.
  if (parsed >= 1e15) {
    return 0;
  }

  return parsed;
}

function detectCgroupMemoryLimit() {
  const sources = [
    {
      filePath: "/sys/fs/cgroup/memory.max",
      source: "cgroup_v2_memory.max",
    },
    {
      filePath: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
      source: "cgroup_v1_memory.limit_in_bytes",
    },
  ];

  for (const candidate of sources) {
    const raw = readTextFile(candidate.filePath);
    if (!raw) {
      continue;
    }

    const bytes = normalizeMemoryLimitBytes(raw);
    if (bytes > 0) {
      return {
        bytes,
        mb: toMb(bytes),
        source: candidate.source,
        raw,
      };
    }

    if (raw.toLowerCase() === "max") {
      return {
        bytes: 0,
        mb: 0,
        source: candidate.source,
        raw,
      };
    }
  }

  return {
    bytes: 0,
    mb: 0,
    source: "",
    raw: "",
  };
}

function inspectAuthPath(authDataPath) {
  const normalized = path.isAbsolute(authDataPath)
    ? authDataPath
    : path.resolve(process.cwd(), authDataPath || ".wwebjs_auth");

  let writable = false;
  let exists = false;

  try {
    fs.mkdirSync(normalized, { recursive: true });
    exists = fs.existsSync(normalized);
    fs.accessSync(normalized, fs.constants.W_OK);
    writable = true;
  } catch (_error) {
    writable = false;
    exists = fs.existsSync(normalized);
  }

  const likelyPersistent = normalized === "/var/data" || normalized.startsWith("/var/data/");

  return {
    authDataPath: normalized,
    authDataPathExists: exists,
    authDataPathWritable: writable,
    authDataPathLikelyPersistent: likelyPersistent,
  };
}

function collectRuntimeEnvironmentDiagnostics({ authDataPath }) {
  const cgroup = detectCgroupMemoryLimit();
  const authPath = inspectAuthPath(authDataPath);

  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    cwd: process.cwd(),
    memoryLimitMb: cgroup.mb,
    memoryLimitBytes: cgroup.bytes,
    memoryLimitSource: cgroup.source,
    memoryLimitRaw: cgroup.raw,
    memoryLimitDetected: cgroup.bytes > 0,
    ...authPath,
  };
}

module.exports = {
  collectRuntimeEnvironmentDiagnostics,
};
