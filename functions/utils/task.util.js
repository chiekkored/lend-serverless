const { OAuth2Client } = require("google-auth-library");

const oauthClient = new OAuth2Client();

function getTaskServiceAccountEmail(projectId) {
  return process.env.TASKS_SERVICE_ACCOUNT_EMAIL || `${projectId}@appspot.gserviceaccount.com`;
}

function isEmulatorRequest(request) {
  return (
    process.env.FUNCTIONS_EMULATOR === "true" ||
    request.get("host")?.includes("localhost") ||
    request.get("host")?.includes("127.0.0.1")
  );
}

async function verifyCloudTaskRequest(request) {
  if (isEmulatorRequest(request)) {
    return;
  }

  const authorization = request.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    throw new Error("Missing OIDC bearer token");
  }

  const idToken = authorization.slice("Bearer ".length);
  const audience = `https://${request.get("host")}${request.originalUrl}`;
  const projectId = process.env.GCP_PROJECT;
  const expectedEmail = getTaskServiceAccountEmail(projectId);

  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience,
  });

  const payload = ticket.getPayload();
  if (!payload?.email || payload.email !== expectedEmail) {
    throw new Error("Unexpected Cloud Tasks service account");
  }
}

module.exports = {
  getTaskServiceAccountEmail,
  verifyCloudTaskRequest,
};
