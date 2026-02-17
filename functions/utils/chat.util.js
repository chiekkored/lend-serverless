const admin = require("firebase-admin");

exports.sendSystemChatMessage = async ({
  chatId,
  ownerId,
  renterId,
  messageText,
  messageType,
  includeOwner = true,
  includeRenter = true,
}) => {
  const firestore = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;

  const chatsRef = firestore.collection("chats").doc(chatId).collection("messages").doc();

  const ownerUserChatRef = firestore.collection("userChats").doc(ownerId).collection("chats").doc(chatId);

  const renterUserChatRef = firestore.collection("userChats").doc(renterId).collection("chats").doc(chatId);

  const messageData = {
    id: chatsRef.id,
    text: messageText,
    senderId: "", // System message
    createdAt: FieldValue?.serverTimestamp() || new Date(),
    type: messageType,
  };

  const chatUpdateData = {
    lastMessage: messageText, // This might need to be adjusted for rating messages
    lastMessageDate: FieldValue?.serverTimestamp() || new Date(),
    lastMessageSenderId: "", // System message
    hasRead: false,
  };

  await firestore.runTransaction(async (transaction) => {
    transaction.set(chatsRef, messageData);
    if (includeOwner) transaction.update(ownerUserChatRef, chatUpdateData);
    if (includeRenter) transaction.update(renterUserChatRef, chatUpdateData);
  });
};
