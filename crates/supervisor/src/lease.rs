#[derive(Debug, Clone, Default)]
pub struct Lease {
    held: bool,
}

impl Lease {
    pub fn acquire(&mut self) {
        self.held = true;
    }

    pub fn release(&mut self) {
        self.held = false;
    }

    pub fn is_held(&self) -> bool {
        self.held
    }
}
