import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

// -------- Load Firebase Service Account ------------------------------
const saRaw =
  process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_CONFIG;

if (!saRaw) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT or FIREBASE_CONFIG env variable");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(saRaw);
} catch (err) {
  console.error("❌ Invalid JSON in FIREBASE_SERVICE_ACCOUNT:", err);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
console.log("✅ Firebase initialized");

// -------- NOWPayments Secret -----------------------------------------
const NOWPAYMENTS_SECRET = process.env.NOWPAYMENTS_SECRET;
if (!NOWPAYMENTS_SECRET) {
  console.warn("⚠️ NOWPAYMENTS_SECRET not set — signature verification will fail");
}

// -------- Webhook Endpoint -------------------------------------------
app.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-nowpayments-sig"];

    if (!signature || signature !== NOWPAYMENTS_SECRET) {
      console.log("❌ Invalid signature");
      return res.status(401).send("Unauthorized");
    }

    const data = req.body;
    console.log("💰 Payment Received:", JSON.stringify(data));

    if (data.payment_status !== "finished") {
      console.log("⏳ Payment not completed. Ignored.");
      return res.status(200).send("ignored");
    }

    // Order ID format: sapp_<productKey>_<userId>_<timestamp>
    const parts = (data.order_id || "").split("_");

    if (parts.length < 3 || parts[0] !== "sapp") {
      console.log("❌ Invalid order_id:", data.order_id);
      return res.status(400).send("Invalid order_id");
    }

    const productKey = parts[1]; // example: beginner_structured
    const userId = parts[2];

    // Save to Firestore
    await db
      .collection("payments")
      .doc(userId)
      .set(
        {
          [productKey]: {
            status: "paid",
            amount: data.price_amount || null,
            currency: data.pay_currency || null,
            timestamp: new Date().toISOString(),
          },
        },
        { merge: true }
      );

    console.log(`✅ Unlocked product '${productKey}' for user '${userId}'`);
    return res.status(200).send("ok");
  } catch (err) {
    console.error("🔥 Webhook Error:", err);
    return res.status(500).send("server error");
  }
});

// -------- Start Server -----------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Webhook server running on port ${PORT}`));
