// offscreen 창이 구독할 Firestore 발주서 (가져가면 지워지므로 남은 것 전부)
self.LISTEN_TARGET = { collectionId: 'adminOutbox', pendingOnly: false };
