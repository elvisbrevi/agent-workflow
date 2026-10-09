//! Desktop and headless adapters around the same `lz` machine core.
pub mod core;
#[cfg(feature = "desktop")]
mod desktop;
mod environment;
mod run_log;
mod runner;
mod settings;
#[cfg(feature = "desktop")]
pub use desktop::run;
#[cfg(feature = "web")]
pub mod web;
