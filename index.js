import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import Brevo from "@getbrevo/brevo"; // <-- NEW: Brevo SDK

const app = express();
app.use(cors());
app.use(express.json());

// ========================================================
// FIREBASE INITIALIZATION (Render environment)
// ========================================================
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
  console.error("❌ Invalid JSON in FIREBASE_SERVICE_ACCOUNT:", err);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

console.log("✅ Firebase connected successfully!");
const db = admin.firestore();

// ========================================================
// BREVO INITIALIZATION
// ========================================================
const brevoEmailApi = new Brevo.TransactionalEmailsApi();
brevoEmailApi.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY // <-- Put this in Render
);

// Helper function to send email
async function sendCourseUnlockedEmail(to, courseName) {
  try {
    const emailData = {
      sender: { name: "SAPP Academy", email: "sapp.academy2025@gmail.com" },
      to: [{ email: to }],
      subject: `🎉 Your ${courseName} Course is Now Unlocked!`,
      htmlContent: `
        <h2>Congratulations!</h2>
        <p>Your course <b>${courseName}</b> is now unlocked.</p>
        <p>You can now login anytime:</p>
        <a href="https://sapp-academy.web.app" target="_blank">
          Go to Dashboard
        </a>
      `,
    };

    await brevoEmailApi.sendTransacEmail(emailData);
    console.log("📧 Brevo email sent to", to);
  } catch (err) {
    console.error("🔥 Error sending Brevo email:", err);
  }
}

// ========================================================
// NOWPAYMENTS WEBHOOK — with full transaction logging
// ========================================================
const NOWPAYMENTS_SECRET = process.env.NOWPAYMENTS_SECRET;

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

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
      console.log("ℹ️ Payment not finished, ignoring.");
      return res.status(200).send("ignored");
    }

    const orderId = data.order_id || "";
    const parts = orderId.split("_");

    if (parts.length < 3 || parts[0] !== "sapp") {
      console.log("❌ Invalid order_id format:", orderId);
      return res.status(400).send("Invalid order_id");
    }

    const planSlug = parts[1];
    const userId = parts[2];

    if (!userId) {
      console.log("❌ userId missing in order ID");
      return res.status(400).send("Missing userId");
    }

    const amount = toNumber(data.price_amount);
    const currency = data.pay_currency || data.price_currency || null;
    const customerEmail = data.customer_email || null;

    const txnId =
      data.payment_id || data.invoice_id || orderId || `np_${Date.now()}`;

    await db
      .collection("payments")
      .doc(userId)
      .set(
        {
          [planSlug]: {
            status: "paid",
            amount,
            currency,
            gateway: "NOWPayments",
            email: customerEmail,
            orderId,
            txnId,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          },
        },
        { merge: true }
      );

    console.log(`✅ Updated payments for user '${userId}' plan '${planSlug}'`);

    await db
      .collection("transactions")
      .doc(String(txnId))
      .set(
        {
          userId,
          email: customerEmail,
          plan: planSlug,
          amount,
          currency,
          status: "paid",
          gateway: "NOWPayments",
          orderId,
          nowpaymentsPaymentId: data.payment_id || null,
          nowpaymentsInvoiceId: data.invoice_id || null,
          raw: data,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    console.log(`🧾 Transaction '${txnId}' saved.`);

    // -----------------------------------------------------------
    // NEW: Send Course Unlocked Email Automatically
    // -----------------------------------------------------------
    if (customerEmail) {
      await sendCourseUnlockedEmail(customerEmail, planSlug);
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("🔥 Webhook error:", err);
    return res.status(500).send("server error");
  }
});

// ========================================================
// BREVO EMAIL EVENT WEBHOOK
// ========================================================
app.post("/brevo/webhook", async (req, res) => {
  try {
    const event = req.body;

    console.log("📩 Brevo event received:", event);

    if (!event.email) return res.status(200).send("no email");

    await db.collection("emailEvents").add({
      email: event.email.toLowerCase(),
      event: event.event || "unknown",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      raw: event,
    });

    return res.status(200).send("stored");
  } catch (err) {
    console.error("🔥 Brevo webhook error:", err);
    return res.status(500).send("error");
  }
});

// ========================================================
// /subscribe — Save subscriber from front-end
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
        uid,
        status: "active",
        source,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      const id = q.docs[0].id;
      await db.collection("subscribers").doc(id).update({
        uid,
        source,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return res.status(200).send("saved");
  } catch (err) {
    console.error("🔥 Subscribe error:", err);
    return res.status(500).send("error");
  }
});

// ========================================================
// START SERVER
// ========================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
