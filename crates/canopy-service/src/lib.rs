//! `canopy-serviced`: the Canopy harness where cloud agents run.
//!
//! See docs/canopy-service-design.md for why and
//! docs/canopy-service-protocol.md for the wire contract this implements.

pub mod admin;
pub mod agent;
pub mod attention;
pub mod config;
pub mod harness;
pub mod http;
pub mod ledger;
pub mod meshtext;
pub mod relay;
pub mod service;
pub mod stream;
pub mod terminals;
pub mod tools;
pub mod util;
pub mod workspace;

pub use config::Config;
pub use service::{start, Running, Service, StartOptions};
