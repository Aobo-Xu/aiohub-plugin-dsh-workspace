use std::time::Duration;

const INITIAL_BACKOFF: Duration = Duration::from_millis(100);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct Recovery {
    next_backoff: Duration,
    max_backoff: Duration,
}

impl Default for Recovery {
    fn default() -> Self {
        Self::new()
    }
}

impl Recovery {
    pub fn new() -> Self {
        Self {
            next_backoff: INITIAL_BACKOFF,
            max_backoff: MAX_BACKOFF,
        }
    }

    pub fn next_restart_delay(&mut self) -> Duration {
        let delay = self.next_backoff;
        self.next_backoff = delay.saturating_mul(2).min(self.max_backoff);
        delay
    }

    pub fn reset(&mut self) {
        self.next_backoff = INITIAL_BACKOFF;
    }
}
