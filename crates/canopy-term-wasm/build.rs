//! On wasm32 the engine runs on the caller's thread with the linker's default
//! stack (1 MiB). Natively it gets an 8 MiB thread stack (canopy-term-core's
//! engine thread), so give the wasm module the same, explicitly.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-link-arg=-zstack-size=8388608");
    }
}
