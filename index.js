import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

// ========================================================
//  FIREBASE INITIALIZATION
// ========================================================
const saRaw =
  process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_CONFIG;

if (!saRaw) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT env variable");
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
console.log("✅ Firebase connected!");

const db = admin.firestore();

// ========================================================
//  NOWPAYMENTS WEBHOOK
// ========================================================
const NOWPAYMENTS_SECRET = process.env.NOWPAYMENTS_SECRET;

app.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-nowpayments-sig"];
    if (!signature || signature !== NOWPAYMENTS_SECRET) {
      console.log("❌ Invalid signature:", signature);
      return res.status(401).send("Unauthorized");
    }

    const data = req.body;
    console.log("💰 Payment received:", data);

    if (data.payment_status !== "finished") {
      console.log("⏳ Payment not finished yet");
      return res.status(200).send("ignored");
    }

    const parts = (data.order_id || "").split("_");
    if (parts.length < 3 || parts[0] !== "sapp") {
      console.log("❌ Invalid order_id:", data.order_id);
      return res.status(400).send("Invalid order_id");
    }

    const course = parts[1];
    const userId = parts[2];

    await db
      .collection("payments")
      .doc(userId)
      .set(
        {
          [course]: {
            status: "paid",
            amount: data.price_amount || null,
            currency: data.pay_currency || null,
            timestamp: Date.now(),
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

// ========================================================
//  BREVO WEBHOOK — store email events (open, click, bounce...)
// ========================================================

app.post("/brevo/webhook", async (req, res) => {
  try {
    const event = req.body;

    console.log("📩 Brevo event received:", event);

    if (!event.email) return res.status(200).send("no email");

    await db.collection("emailEvents").add({
      email: event.email.toLowerCase(),
      event: event.event || "unknown",
      timestamp: Date.now(),
      raw: event,
    });

    return res.status(200).send("stored");
  } catch (err) {
    console.error("🔥 Brevo webhook error:", err);
    return res.status(500).send("error");
  }
});

// ========================================================
// OPTIONAL: Add subscriber from website
// ========================================================
app.post("/subscribe", async (req, res) => {
  try {
    const { email, uid = null, source = "manual" } = req.body;

    if (!email) return res.status(400).send("Missing email");

    const lower = email.toLowerCase();

    const q = await db
      .collection("subscribers")
      .where("email", "==", lower)
      .get();

    if (q.empty) {
      await db.collection("subscribers").add({
        email: lower,
        uid: uid,
        status: "active",
        source,
        createdAt: Date.now(),
      });
    } else {
      const id = q.docs[0].id;
      await db.collection("subscribers").doc(id).update({
        uid,
        source,
        updatedAt: Date.now(),
      });
    }

    return res.status(200).send("saved");
  } catch (err) {
    console.error("🔥 Subscribe error:", err);
    return res.status(500).send("error");
  }
});

// ========================================================
//  START SERVER
// ========================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
