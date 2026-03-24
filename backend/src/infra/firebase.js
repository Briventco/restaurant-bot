const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

function resolveCredential() {
  const configuredPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const defaultLocalPath = path.resolve(__dirname, "../../serviceAccountKey.json");
  const keyPath = configuredPath || defaultLocalPath;
  const metadata = {
    hasConfiguredServiceAccountPath: Boolean(configuredPath),
    resolvedCredentialPath: keyPath,
    serviceAccountProjectId: "",
    serviceAccountClientEmail: "",
    initMode: "adc",
  };

  if (!fs.existsSync(keyPath)) {
    return {
      credential: null,
      metadata,
    };
  }

  // eslint-disable-next-line global-require, import/no-dynamic-require
  const serviceAccount = require(keyPath);
  metadata.serviceAccountProjectId = String(serviceAccount.project_id || "");
  metadata.serviceAccountClientEmail = String(serviceAccount.client_email || "");
  metadata.initMode = "cert";

  return {
    credential: admin.credential.cert(serviceAccount),
    metadata,
  };
}

if (!admin.apps.length) {
  const resolved = resolveCredential();
  const credential = resolved.credential;

  if (credential) {
    admin.initializeApp({
      credential,
      projectId: resolved.metadata.serviceAccountProjectId || undefined,
    });
  } else {
    admin.initializeApp();
  }

  // Temporary safe diagnostics for credential source verification.
  console.info(
    "[firebase-init]",
    JSON.stringify({
      hasConfiguredServiceAccountPath:
        resolved.metadata.hasConfiguredServiceAccountPath,
      resolvedCredentialPath: resolved.metadata.resolvedCredentialPath,
      serviceAccountProjectId: resolved.metadata.serviceAccountProjectId,
      serviceAccountClientEmail: resolved.metadata.serviceAccountClientEmail,
      initMode: resolved.metadata.initMode,
    })
  );
}

const db = admin.firestore();

module.exports = {
  admin,
  db,
  FieldValue: admin.firestore.FieldValue,
};
