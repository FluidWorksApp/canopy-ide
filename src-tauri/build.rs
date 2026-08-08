fn main() {
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
