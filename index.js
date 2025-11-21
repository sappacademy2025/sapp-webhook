import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------------
// Load Firebase Admin Credentials
// ---------------------------------------------------------------------------
const saRaw =
  process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_CONFIG;

if (!saRaw) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT environment variable");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(saRaw);
} catch (err) {
  console.error("❌ Invalid FIREBASE_SERVICE_ACCOUNT JSON:", err);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

console.log("✅ Firebase Admin initialized");
const db = admin.firestore();

// ---------------------------------------------------------------------------
// Load NOWPayments Secret
// ---------------------------------------------------------------------------
const NOWPAYMENTS_SECRET = process.env.NOWPAYMENTS_SECRET;

if (!NOWPAYMENTS_SECRET) {
  console.warn("⚠️ NOWPAYMENTS_SECRET missing — signatures cannot be validated.");
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-nowpayments-sig"];

    // Verify signature
    if (!signature || signature !== NOWPAYMENTS_SECRET) {
      console.log("❌ Invalid signature");
      return res.status(401).send("Unauthorized");
    }

    const data = req.body;
    console.log("💰 Received Payment:", JSON.stringify(data));

    if (data.payment_status !== "finished") {
      console.log("⌛ Payment not finished, ignoring.");
      return res.status(200).send("ignored");
    }

    // Expect: sapp_<course>_<userId>_<timestamp>
    const parts = (data.order_id || "").split("_");

    if (parts.length < 3 || parts[0] !== "sapp") {
      console.log("❌ Invalid order_id:", data.order_id);
      return res.status(400).send("Invalid order_id");
    }

    const course = parts[1];
    const userId = parts[2];

    // -----------------------------------------------------------------------
    // Fetch user's email from Firestore (if exists)
    // -----------------------------------------------------------------------
    let email = "unknown";

    try {
      const userDoc = await db.collection("users").doc(userId).get();
      if (userDoc.exists) {
        email = userDoc.data().email || "unknown";
      }
    } catch (err) {
      console.log("⚠️ Failed to fetch user email");
    }

    // -----------------------------------------------------------------------
    // Save payment unlock
    // -----------------------------------------------------------------------
    await db
      .collection("payments")
      .doc(userId)
      .set(
        {
          [course]: {
            status: "paid",
            amount: data.price_amount || null,
            currency: data.pay_currency || null,
            timestamp: new Date().toISOString(),
          },
        },
        { merge: true }
      );

    // -----------------------------------------------------------------------
    // Save full transaction record
    // -----------------------------------------------------------------------
    const txnId = `txn_${Date.now()}_${Math.floor(Math.random() * 999999)}`;

    await db.collection("transactions").doc(txnId).set({
      txnId,
      userId,
      email,
      plan: course,
      amount: data.price_amount || 0,
      currency: data.pay_currency || "USD",
      status: "paid",
      gateway: "NOWPayments",
      raw: data,
      timestamp: new Date().toISOString(),
    });

    console.log(`✅ Saved transaction ${txnId} & unlocked course '${course}'`);
    return res.status(200).send("ok");
  } catch (err) {
    console.error("🔥 Webhook Error:", err);
    return res.status(500).send("server error");
  }
});

// ---------------------------------------------------------------------------
// Start Web Server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Webhook server online on port ${PORT}`));
