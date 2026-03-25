const { createApp, API_BASE } = require("./app");
const { env } = require("./config/env");
const { runStartupChecks } = require("./config/startupChecks");
const logger = require("./infra/logger");

runStartupChecks({ env, logger });
const app = createApp();

console.log("BOOTING RESTAURANT BACKEND APP");
console.log("API_BASE =", API_BASE);
console.log(
  "ROUTE_MAP =",
  ["/", "/test", `${API_BASE}/health`, `${API_BASE}/status`].join(", ")
);

app.listen(env.PORT, () => {
  logger.info("Backend service started", {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
  });
});
