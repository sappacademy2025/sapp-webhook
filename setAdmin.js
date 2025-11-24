import admin from "firebase-admin";
import dotenv from "dotenv";
dotenv.config();

// LOAD SERVICE ACCOUNT
const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!saRaw) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(saRaw)),
});

async function makeAdmin() {
  // TODO: Replace this uid with your UID
  const uid = "djKfUn49ZBVzjeK8wT2jHcsEAeS2";

  await admin.auth().setCustomUserClaims(uid, { admin: true });
  console.log("🔥 SUCCESS: User is now ADMIN:", uid);
}

makeAdmin();
