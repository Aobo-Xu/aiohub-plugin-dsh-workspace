pub struct Credentials;

impl Credentials {
    pub fn new() -> Self {
        Self
    }
}

impl Default for Credentials {
    fn default() -> Self {
        Self::new()
    }
}
