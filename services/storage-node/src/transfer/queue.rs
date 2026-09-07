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

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str) -> ShardTransferRequest {
        ShardTransferRequest {
            transfer_id: id.to_string(),
            file_id: "f1".into(),
            version_number: 1,
            shard_index: 0,
            data: vec![1],
            hash: "hash".into(),
            object_id: "hash".into(),
            target_node: "node-1".into(),
            source_device: None,
        }
    }

    #[tokio::test]
    async fn enqueue_dequeue_is_fifo() {
        let q = MemoryLocalQueue::new();
        q.enqueue(request("a")).await;
        q.enqueue(request("b")).await;
        assert_eq!(q.len().await, 2);
        assert!(!q.is_empty().await);
        assert_eq!(q.peek().await.unwrap().transfer_id, "a");
        assert_eq!(q.dequeue().await.unwrap().transfer_id, "a");
        assert_eq!(q.dequeue().await.unwrap().transfer_id, "b");
        assert!(q.is_empty().await);
        assert!(q.dequeue().await.is_none());
    }

    #[tokio::test]
    async fn remove_drops_matching_transfer_id() {
        let q = MemoryLocalQueue::new();
        q.enqueue(request("a")).await;
        q.enqueue(request("b")).await;
        q.remove("a").await;
        assert_eq!(q.len().await, 1);
        assert_eq!(q.dequeue().await.unwrap().transfer_id, "b");
    }
}
