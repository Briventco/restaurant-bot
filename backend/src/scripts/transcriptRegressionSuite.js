/* eslint-disable no-console */
const crypto = require("crypto");

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function buildProviderMessageId(prefix, turn, text) {
  const hash = crypto.createHash("sha1").update(`${prefix}:${turn}:${text}`).digest("hex").slice(0, 12);
  return `${prefix}_${turn}_${hash}`;
}

async function postInbound({ baseUrl, apiKey, restaurantId, payload }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/restaurants/${encodeURIComponent(
    restaurantId
  )}/messages/inbound`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function includesAny(value, expectedTypes) {
  const type = String((value && value.type) || "");
  return expectedTypes.some((candidate) => type === candidate);
}

async function runScenario({ baseUrl, apiKey, restaurantId, scenario }) {
  console.log(`\n=== ${scenario.name} ===`);
  let passed = 0;

  for (let index = 0; index < scenario.turns.length; index += 1) {
    const turn = scenario.turns[index];
    const providerMessageId = buildProviderMessageId(scenario.id, index + 1, turn.text);
    const result = await postInbound({
      baseUrl,
      apiKey,
      restaurantId,
      payload: {
        channel: "whatsapp-web",
        channelCustomerId: scenario.channelCustomerId,
        customerPhone: scenario.customerPhone,
        displayName: scenario.displayName || "Regression User",
        text: turn.text,
        providerMessageId,
        timestamp: Date.now() + index,
        type: "chat",
      },
    });

    const ok = includesAny(result, turn.expectAnyType);
    const marker = ok ? "PASS" : "FAIL";
    console.log(
      `[${marker}] #${index + 1} "${turn.text}" -> type=${String(result.type || "unknown")} expected=${turn.expectAnyType.join(
        "|"
      )}`
    );
    if (ok) {
      passed += 1;
    }
  }

  const scenarioPassed = passed === scenario.turns.length;
  console.log(
    `Scenario result: ${scenarioPassed ? "PASS" : "FAIL"} (${passed}/${scenario.turns.length})`
  );
  return scenarioPassed;
}

async function main() {
  const baseUrl = requiredEnv("REGRESSION_BASE_URL");
  const apiKey = requiredEnv("REGRESSION_API_KEY");
  const restaurantId = requiredEnv("REGRESSION_RESTAURANT_ID");

  const scenarios = [
    {
      id: "multi_item_pickup_confirm",
      name: "Menu -> Multi item -> Pickup -> Confirm",
      channelCustomerId: "2349000000001@c.us",
      customerPhone: "+2349000000001",
      turns: [
        { text: "menu", expectAnyType: ["guided_menu", "llm_menu_request"] },
        { text: "2 amala and 2 egg", expectAnyType: ["guided_multi_item_fulfillment_prompt", "guided_fulfillment_prompt_late_parse"] },
        { text: "p", expectAnyType: ["guided_confirmation_prompt", "guided_confirmation_prompt_late_parse"] },
        { text: "yes", expectAnyType: ["guided_order_created"] },
      ],
    },
    {
      id: "delivery_and_quantity_edit",
      name: "Mixed edit: delivery + quantity",
      channelCustomerId: "2349000000002@c.us",
      customerPhone: "+2349000000002",
      turns: [
        { text: "jollof rice", expectAnyType: ["guided_quantity_prompt", "guided_fulfillment_prompt"] },
        { text: "1", expectAnyType: ["guided_fulfillment_prompt"] },
        { text: "delivery is fine but make it 4 portions", expectAnyType: ["guided_address_prompt", "guided_confirmation_prompt"] },
      ],
    },
    {
      id: "payment_report_flow",
      name: "Awaiting payment should not fall to menu/llm fallback",
      channelCustomerId: "2349000000003@c.us",
      customerPhone: "+2349000000003",
      turns: [
        { text: "i have paid", expectAnyType: ["payment_reported", "payment_reported_with_reference", "payment_already_under_review", "payment_flow_reminder"] },
        { text: "Badmus Qudus Ayomide 4000 UBA transfer", expectAnyType: ["payment_reference_saved", "payment_flow_reminder"] },
      ],
    },
  ];

  let suitePassed = 0;
  for (const scenario of scenarios) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await runScenario({ baseUrl, apiKey, restaurantId, scenario });
    if (ok) {
      suitePassed += 1;
    }
  }

  const total = scenarios.length;
  console.log(`\nSuite summary: ${suitePassed}/${total} scenarios passed`);
  if (suitePassed !== total) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Transcript regression suite failed:", error.message);
  process.exitCode = 1;
});

