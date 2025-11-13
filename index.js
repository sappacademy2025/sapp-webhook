import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

// --- Load Firebase service account from env var ------------------------------------------------
const saRaw =
  process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_CONFIG;
if (!saRaw) {
  console.error(
    "❌ Missing FIREBASE_SERVICE_ACCOUNT (or FIREBASE_CONFIG) environment variable"
  );
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
console.log("✅ Firebase connected successfully!");

const db = admin.firestore();

// --- NowPayments secret ------------------------------------------------
const NOWPAYMENTS_SECRET = process.env.NOWPAYMENTS_SECRET;
if (!NOWPAYMENTS_SECRET) {
  console.warn(
    "⚠️ NOWPAYMENTS_SECRET not set — signature verification will fail"
  );
}

// --- TEMP TEST ROUTE ------------------------------------------------
// Unlocks a course without paying (for testing)
app.get("/test-unlock", async (req, res) => {
  try {
    const userId = req.query.uid || "TEST_USER";
    const course = req.query.course || "beginner";

    await db
      .collection("payments")
      .doc(userId)
      .set(
        {
          [course]: {
            status: "paid",
            amount: "TEST",
            currency: "TEST",
            timestamp: new Date().toISOString(),
          },
        },
        { merge: true }
      );

    console.log(
      `🎉 TEST UNLOCK: Course '${course}' unlocked for user '${userId}'`
    );
    res.send(`TEST UNLOCK SUCCESS → User: ${userId}, Course: ${course}`);
  } catch (err) {
    console.error("🔥 TEST UNLOCK ERROR:", err);
    res.status(500).send("error");
  }
});

// --- Webhook endpoint ------------------------------------------------
app.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-nowpayments-sig"];
    if (!signature || signature !== NOWPAYMENTS_SECRET) {
      console.log("❌ Invalid signature:", signature);
      return res.status(401).send("Unauthorized");
    }

    const data = req.body;
    console.log("💰 Payment received:", JSON.stringify(data));

    if (data.payment_status !== "finished") {
      console.log("Payment not finished, ignoring.");
      return res.status(200).send("ignored");
    }

    // Expect order_id format: sapp_<course>_<userId>_<timestamp>
    const parts = (data.order_id || "").split("_");
    if (parts.length < 3 || parts[0] !== "sapp") {
      console.log("❌ Invalid order_id:", data.order_id);
      return res.status(400).send("Invalid order_id");
    }
    const course = parts[1];
    const userId = parts[2];

    // Write to Firestore
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

    console.log(`✅ Course '${course}' unlocked for user '${userId}'`);
    return res.status(200).send("ok");
  } catch (err) {
    console.error("🔥 Webhook error:", err);
    return res.status(500).send("server error");
  }
});

// --- Start server ------------------------------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Webhook running on port ${PORT}`));
