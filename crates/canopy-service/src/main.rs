//! `canopy-serviced`. Configured from the environment (see `Config`); flags
//! override. Runs until SIGTERM or SIGINT.

use canopy_service::harness::CoreHarness;
use std::sync::Arc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version") {
        println!("canopy-serviced {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let config = match canopy_service::Config::from_env_and_args(|k| std::env::var(k).ok(), &args) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("canopy-serviced: {error}");
            std::process::exit(2);
        }
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("the tokio runtime starts");
    let code = runtime.block_on(async move {
        let running = match canopy_service::start(
            config,
            canopy_service::StartOptions {
                harness: Arc::new(CoreHarness::default()),
                relay: None,
                relay_loop: true,
            },
        )
        .await
        {
            Ok(running) => running,
            Err(error) => {
                eprintln!("canopy-serviced: {error}");
                return 1;
            }
        };
        eprintln!("canopy-serviced: ready");
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler installs");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
        // Bounded shutdown: stop accepting, drop connections, keep every store.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), running.shutdown()).await;
        0
    });
    std::process::exit(code);
}
