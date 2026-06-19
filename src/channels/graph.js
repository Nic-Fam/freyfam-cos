import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { GRAPH } from "../config.js";
import { assertOutboundAllowed } from "../guards.js";

// App-only auth (client credentials) against the assistant@freyfam.com mailbox.
let _client;
function graph() {
  if (_client) return _client;
  const credential = new ClientSecretCredential(
    GRAPH.tenantId,
    GRAPH.clientId,
    GRAPH.clientSecret
  );
  _client = Client.initWithMiddleware({
    authProvider: {
      getAccessToken: async () => {
        const token = await credential.getToken("https://graph.microsoft.com/.default");
        return token.token;
      },
    },
  });
  return _client;
}

/**
 * Cheap signal fetch for the heartbeat: recent message headers only.
 * Returns a compact array the triage model can scan without a full agent run.
 */
export async function recentMailSignals({ top = 15 } = {}) {
  const res = await graph()
    .api(`/users/${GRAPH.mailbox}/mailFolders/inbox/messages`)
    .top(top)
    .select("from,subject,receivedDateTime,isRead")
    .orderby("receivedDateTime desc")
    .get();
  return (res.value || []).map((m) => ({
    source: "email",
    from: m.from?.emailAddress?.address,
    subject: m.subject,
    receivedAt: m.receivedDateTime,
    unread: !m.isRead,
  }));
}

/**
 * Send mail from the assistant mailbox. Outbound guard runs FIRST so the
 * read-only work domains can never receive a message from the assistant.
 */
export async function sendMail({ to, subject, body }) {
  const recipients = Array.isArray(to) ? to : [to];
  assertOutboundAllowed(recipients);
  await graph()
    .api(`/users/${GRAPH.mailbox}/sendMail`)
    .post({
      message: {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    });
}
