fn main() {
    // Winit needs the main thread (macOS requires it), so everything runs here.
    std::process::exit(canopy_term_app::run(std::env::args().skip(1).collect()));
}
