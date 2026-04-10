#!/usr/bin/env node

const { env } = require("../config/env");
const restaurantRepo = require("../repositories/restaurantRepo");
const userRepo = require("../repositories/userRepo");
const menuRepo = require("../repositories/menuRepo");
const providerSessionRepo = require("../repositories/providerSessionRepo");
const restaurantHealthRepo = require("../repositories/restaurantHealthRepo");
const activationJobRepo = require("../repositories/activationJobRepo");
const {
  resolveWhatsappChannelStatus,
} = require("../utils/whatsappChannelStatus");
const {
  buildRestaurantActivationValidation,
} = require("../domain/services/restaurantActivationValidationService");

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }

    out[key] = next;
    index += 1;
  }

  return out;
}

function inferActivationState(restaurant = {}, whatsapp = null) {
  const explicitState = String(
    restaurant &&
      restaurant.activation &&
      typeof restaurant.activation === "object" &&
      restaurant.activation.state
      ? restaurant.activation.state
      : ""
  )
    .trim()
    .toLowerCase();

  if (explicitState) {
    return explicitState;
  }

  if (whatsapp && whatsapp.bindingMode === "session") {
    return "active";
  }

  if (
    whatsapp &&
    (whatsapp.bindingMode === "configured_pending_session" ||
      whatsapp.bindingMode === "global_meta_default")
  ) {
    return "configured";
  }

  return "draft";
}

function summarizeIssues(items) {
  if (!Array.isArray(items) || !items.length) {
    return "none";
  }

  return items.join("; ");
}

function printSection(title) {
  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
}

async function buildRestaurantAudit(restaurant) {
  const [users, menuItems, session, currentHealth, latestActivationJob] = await Promise.all([
    userRepo.listUsersByRestaurantId(restaurant.id),
    menuRepo.listMenuItems(restaurant.id),
    providerSessionRepo.getSession(restaurant.id, "whatsapp-web"),
    restaurantHealthRepo.getCurrentHealth(restaurant.id),
    activationJobRepo.getLatestActivationJobByRestaurantId(restaurant.id),
  ]);

  const adminUser =
    users.find((user) => user.role === "restaurant_admin") || users[0] || null;
  const whatsapp = resolveWhatsappChannelStatus({
    restaurant,
    restaurantId: restaurant.id,
    session,
    env,
  });
  const validation = buildRestaurantActivationValidation({
    restaurant,
    adminUser,
    menuItems,
    whatsapp,
  });
  const activationState = inferActivationState(restaurant, whatsapp);
  const blockers = (validation.checklist.items || [])
    .filter((item) => item.severity === "blocker")
    .flatMap((item) => item.issues || []);
  const warnings = (validation.checklist.items || [])
    .filter((item) => item.severity === "warning")
    .flatMap((item) => item.issues || []);

  return {
    id: restaurant.id,
    name: restaurant.name || "Restaurant",
    activationState,
    healthStatus: currentHealth && currentHealth.status ? currentHealth.status : "unknown",
    whatsappStatus: whatsapp.status || "unknown",
    provisioningState: whatsapp.provisioningState || "unassigned",
    activationReady: Boolean(whatsapp.activationReady),
    latestActivationJobStatus: latestActivationJob ? latestActivationJob.status || "unknown" : "none",
    latestActivationJobStep: latestActivationJob ? latestActivationJob.currentStep || "queued" : "none",
    blockerCount: Number(validation.summary && validation.summary.blockerCount) || 0,
    warningCount: Number(validation.summary && validation.summary.warningCount) || 0,
    blockers,
    warnings,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 50));

  const restaurants = await restaurantRepo.listRestaurants({ limit });
  if (!restaurants.length) {
    console.log("No restaurants found.");
    return;
  }

  const audits = [];
  for (const restaurant of restaurants) {
    // eslint-disable-next-line no-await-in-loop
    audits.push(await buildRestaurantAudit(restaurant));
  }

  printSection("Multi-Tenant Readiness Audit");
  console.table(
    audits.map((item) => ({
      restaurantId: item.id,
      name: item.name,
      lifecycle: item.activationState,
      health: item.healthStatus,
      whatsapp: item.whatsappStatus,
      provisioning: item.provisioningState,
      activationReady: item.activationReady ? "yes" : "no",
      blockers: item.blockerCount,
      warnings: item.warningCount,
      activationJob: `${item.latestActivationJobStatus}/${item.latestActivationJobStep}`,
    }))
  );

  const blocked = audits.filter((item) => item.blockerCount > 0);
  const ready = audits.filter((item) => item.blockerCount === 0 && item.activationReady);
  const unhealthy = audits.filter((item) => item.healthStatus === "critical" || item.healthStatus === "degraded");

  printSection("Summary");
  console.log(`Total restaurants: ${audits.length}`);
  console.log(`Ready for activation checks: ${ready.length}`);
  console.log(`With blockers: ${blocked.length}`);
  console.log(`With degraded/critical health: ${unhealthy.length}`);

  if (blocked.length) {
    printSection("Blocked Restaurants");
    for (const item of blocked) {
      console.log(`${item.name} (${item.id})`);
      console.log(`  Blockers: ${summarizeIssues(item.blockers)}`);
      if (item.warnings.length) {
        console.log(`  Warnings: ${summarizeIssues(item.warnings)}`);
      }
    }
  }
}

main().catch((error) => {
  console.error("Multi-tenant readiness audit failed.");
  console.error(error.message || error);
  process.exit(1);
});
