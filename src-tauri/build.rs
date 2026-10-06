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

    // Tauri embeds the v6 application manifest itself. Asking link.exe to
    // embed a second one produces CVT1100 in release binaries. Only an explicit
    // Windows library-test invocation needs the standalone test manifest:
    // CANOPY_WINDOWS_TEST_MANIFEST=1 cargo test --lib
    println!("cargo:rerun-if-env-changed=CANOPY_WINDOWS_TEST_MANIFEST");
    if std::env::var_os("CARGO_CFG_WINDOWS").is_some()
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
        && std::env::var("CANOPY_WINDOWS_TEST_MANIFEST").as_deref() == Ok("1")
    {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
    tauri_build::build()
}
