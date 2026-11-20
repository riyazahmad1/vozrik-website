const admin = require("firebase-admin");

async function setAdmin() {
  const uid = process.argv[2];

  if (!uid) {
    console.error("Usage: node set-admin-claim.js USER_UID");
    process.exit(1);
  }

  if (!admin.apps.length) {
    admin.initializeApp();
  }

  await admin.auth().setCustomUserClaims(uid, { admin: true });

  console.log("Admin access granted successfully.");
}

setAdmin().catch((error) => {
  console.error(error);
  process.exit(1);
});
