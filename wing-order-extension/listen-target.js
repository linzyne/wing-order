// offscreen 창이 구독할 Firestore 요청 (받기·송장 올리기 요청 중 기다리는 것만)
self.LISTEN_TARGET = { collectionId: 'wingRequests', pendingOnly: true };
