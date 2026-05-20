const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { sendNotificationToUser } = require("../utils/notification.util");

exports.notifyChatMessage = onDocumentCreated("chats/{chatId}/messages/{messageId}", async (event) => {
    const message = event.data?.data();
    const chatId = event.params.chatId;
    const senderId = message?.senderId;
    const text = message?.text;

    if (!senderId || !text || message?.type === "system") return null;

    const chatMirrors = await admin
      .firestore()
      .collectionGroup("chats")
      .where("chatId", "==", chatId)
      .get();

    const sends = [];
    const seenRecipients = new Set();

    chatMirrors.docs.forEach((doc) => {
      const userChatsRoot = doc.ref.parent.parent;
      const recipientId = userChatsRoot?.id;
      if (!recipientId || recipientId === senderId || seenRecipients.has(recipientId)) {
        return;
      }

      seenRecipients.add(recipientId);
      const chat = doc.data();
      const assetTitle = chat?.asset?.title || "Lend";

      sends.push(
        sendNotificationToUser({
          uid: recipientId,
          title: "New message",
          body: text.length > 120 ? `${text.slice(0, 117)}...` : text,
          data: {
            type: "chat",
            chatId,
            bookingId: chat?.bookingId,
            assetId: chat?.asset?.id,
            senderId,
            title: assetTitle,
          },
        }),
      );
    });

    await Promise.allSettled(sends);
    return null;
  });
