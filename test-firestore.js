#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const admin = require("./backend/node_modules/firebase-admin");

async function main() {
  const keyPath = path.resolve(__dirname, "serviceAccountKey.json");

  if (!fs.existsSync(keyPath)) {
    throw new Error(`Missing credential file: ${keyPath}`);
  }

  const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf8"));

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });
  }

  const db = admin.firestore();
  const snapshot = await db.collection("restaurants").doc("lead_mall").get();

  console.log("Credential path:", keyPath);
  console.log("Project ID:", serviceAccount.project_id || "");
  console.log("Client email:", serviceAccount.client_email || "");
  console.log("Doc exists:", snapshot.exists);
  console.log("Doc data:", snapshot.exists ? snapshot.data() : null);
}

main().catch((error) => {
  console.error("Firestore test failed.");
  console.error(error);
  process.exit(1);
});
