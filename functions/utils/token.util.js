const crypto = require("crypto");

const SECRET = process.env.QR_SECRET;

exports.createSignedToken = (payload) => {
  try {
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    const sig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest("hex");

    return `${payloadB64}.${sig}`;
  } catch (error) {
    console.error("Failed to create signed token:", err);
    throw new functions.https.HttpsError("internal", "Failed to generate signed token", err.message);
  }
};
