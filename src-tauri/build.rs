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

    // tauri-build embeds the Windows application manifest into the app binaries
    // only, so a test harness links without one. It then binds to Common
    // Controls v5, which exports none of the v6 entry points tao subclasses its
    // window with, and the test binary dies at load with
    // STATUS_ENTRYPOINT_NOT_FOUND before a single test runs. Naming the v6
    // dependency for every link target puts that assembly reference in the test
    // binaries too; the app binaries already carry it in their own manifest and
    // the linker merges the duplicate.
    if std::env::var_os("CARGO_CFG_WINDOWS").is_some()
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
    tauri_build::build()
}
