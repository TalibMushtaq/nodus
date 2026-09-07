use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::types::ShardTransferRequest;

/// In-memory queue for Path D local persistent storage.
/// No persistence — platform-specific backends plug in later.
pub struct MemoryLocalQueue {
    items: Arc<Mutex<VecDeque<ShardTransferRequest>>>,
}

impl MemoryLocalQueue {
    pub fn new() -> Self {
        Self {
            items: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    pub async fn enqueue(&self, request: ShardTransferRequest) {
        self.items.lock().await.push_back(request);
    }

    pub async fn dequeue(&self) -> Option<ShardTransferRequest> {
        self.items.lock().await.pop_front()
    }

    pub async fn peek(&self) -> Option<ShardTransferRequest> {
        self.items.lock().await.front().cloned()
    }

    pub async fn remove(&self, transfer_id: &str) {
        let mut items = self.items.lock().await;
        items.retain(|r| r.transfer_id != transfer_id);
    }

    pub async fn len(&self) -> usize {
        self.items.lock().await.len()
    }

    pub async fn is_empty(&self) -> bool {
        self.items.lock().await.is_empty()
    }
}

impl Default for MemoryLocalQueue {
    fn default() -> Self {
        Self::new()
    }
}
