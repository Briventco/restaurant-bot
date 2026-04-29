const fs = require("fs");

function percentile(values, p) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function format(n) {
  return Number.isFinite(n) ? n.toFixed(1) : "n/a";
}

function main() {
  const input = fs.readFileSync(0, "utf8");
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const events = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.perf && typeof parsed.perf === "object") {
        events.push(parsed);
      }
    } catch (_error) {
      // ignore non-JSON lines
    }
  }

  if (!events.length) {
    console.log("No perf events found on stdin.");
    process.exit(0);
  }

  const fields = ["total_ms", "db_ms", "router_ms", "llm_ms"];
  const byHandler = new Map();

  for (const event of events) {
    const handler =
      event &&
      event.decision &&
      typeof event.decision === "object" &&
      event.decision.handler
        ? String(event.decision.handler)
        : "unknown";

    if (!byHandler.has(handler)) {
      byHandler.set(handler, []);
    }
    byHandler.get(handler).push(event);
  }

  console.log(`events=${events.length} handlers=${byHandler.size}`);

  for (const [handler, handlerEvents] of [...byHandler.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    console.log(`\n[${handler}] n=${handlerEvents.length}`);
    for (const field of fields) {
      const values = [];
      for (const event of handlerEvents) {
        const perfValue = toNumber(event.perf && event.perf[field]);
        if (perfValue !== null) {
          values.push(perfValue);
        }
        if (field === "llm_ms") {
          const llmDecisionValue = toNumber(
            event.decision &&
              event.decision.metrics &&
              event.decision.metrics.llm_ms
          );
          if (llmDecisionValue !== null) {
            values.push(llmDecisionValue);
          }
        }
      }

      if (!values.length) {
        continue;
      }

      const p50 = percentile(values, 50);
      const p95 = percentile(values, 95);
      const min = Math.min(...values);
      const max = Math.max(...values);
      console.log(
        `  ${field}: p50=${format(p50)} p95=${format(p95)} min=${format(min)} max=${format(max)}`
      );
    }
  }
}

main();
