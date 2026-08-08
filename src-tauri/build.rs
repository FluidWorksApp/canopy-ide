fn main() {
    // The app and canopy-hook are installed independently. Hash the two ends
    // of their bridge protocol so /ctx/tools can say exactly which contract a
    // running app implements; a newer hook can then withhold calls the older
    // app cannot answer instead of advertising tools that return 404.
    let mut hash = 0xcbf29ce484222325u64;
    for path in ["src/context.rs", "src/bin/canopy_hook.rs"] {
        println!("cargo:rerun-if-changed={path}");
        if let Ok(bytes) = std::fs::read(path) {
            for byte in bytes {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x100000001b3);
            }
        }
    }
    println!("cargo:rustc-env=CANOPY_CONTEXT_BUILD_ID={hash:016x}");
    tauri_build::build()
}
