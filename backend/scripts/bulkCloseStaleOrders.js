const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});

const { db } = require("../src/infra/firebase");
const orderRepo = require("../src/repositories/orderRepo");

const TERMINAL_STATUSES = new Set(["delivered", "cancelled"]);
const COMPLETABLE_STATUSES = new Set(["ready_for_pickup", "rider_dispatched"]);

const TIMESTAMP_FIELD_BY_STATUS = {
  delivered: "deliveredAt",
  cancelled: "cancelledAt",
};

const isCommit = process.argv.includes("--commit");

function planForOrder(order) {
  const status = String(order.status || "").trim();

  if (TERMINAL_STATUSES.has(status)) {
    return null;
  }

  const toStatus = COMPLETABLE_STATUSES.has(status) ? "delivered" : "cancelled";
  return { fromStatus: status, toStatus };
}

async function main() {
  console.log(`[bulk-close] Mode: ${isCommit ? "COMMIT (writing changes)" : "DRY RUN (no writes)"}`);

  const restaurantsSnapshot = await db.collection("restaurants").get();
  console.log(`[bulk-close] Found ${restaurantsSnapshot.size} restaurant(s).`);

  let scanned = 0;
  let toDelivered = 0;
  let toCancelled = 0;
  let skippedTerminal = 0;

  for (const restaurantDoc of restaurantsSnapshot.docs) {
    const restaurantId = restaurantDoc.id;
    const ordersSnapshot = await db
      .collection("restaurants")
      .doc(restaurantId)
      .collection("orders")
      .get();

    for (const orderDoc of ordersSnapshot.docs) {
      const order = { id: orderDoc.id, ...orderDoc.data() };
      scanned += 1;

      const plan = planForOrder(order);
      if (!plan) {
        skippedTerminal += 1;
        continue;
      }

      if (plan.toStatus === "delivered") {
        toDelivered += 1;
      } else {
        toCancelled += 1;
      }

      console.log(
        `[bulk-close] ${isCommit ? "Updating" : "Would update"} restaurant=${restaurantId} order=${order.id} ${plan.fromStatus} -> ${plan.toStatus}`
      );

      if (isCommit) {
        const timestampField = TIMESTAMP_FIELD_BY_STATUS[plan.toStatus];
        await orderRepo.transitionStatusWithHistory({
          restaurantId,
          orderId: order.id,
          toStatus: plan.toStatus,
          fromStatus: plan.fromStatus,
          actor: { type: "system", id: "bulk_stale_order_cleanup" },
          reason: "bulk_stale_order_cleanup",
          patch: {
            [timestampField]: new Date().toISOString(),
          },
        });
      }
    }
  }

  console.log("\n[bulk-close] Summary");
  console.log(`  Orders scanned:        ${scanned}`);
  console.log(`  Already terminal:      ${skippedTerminal}`);
  console.log(`  -> delivered:          ${toDelivered}`);
  console.log(`  -> cancelled:          ${toCancelled}`);
  console.log(
    isCommit
      ? "\n[bulk-close] Done. Changes were written to Firestore."
      : "\n[bulk-close] Dry run complete. No changes were written. Re-run with --commit to apply."
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[bulk-close] Failed:", error);
    process.exit(1);
  });
