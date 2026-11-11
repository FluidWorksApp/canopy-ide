//! Reports what GPU adapter this machine can offer offscreen. A plain `main`
//! (not libtest) so the lines reach the CI log, and it never fails: having no
//! adapter, or a backend that panics while enumerating, is a reported answer.

use std::io::Write;

fn main() {
    let mut out = std::io::stdout();
    let _ = writeln!(
        out,
        "GPU_PROBE os={} arch={}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    match std::panic::catch_unwind(canopy_term_render::gpu::probe) {
        Ok(report) => {
            for line in &report.lines {
                let _ = writeln!(out, "GPU_PROBE {line}");
            }
            let _ = writeln!(
                out,
                "GPU_PROBE RESULT os={} usable_device={}",
                std::env::consts::OS,
                report.usable
            );
        }
        Err(_) => {
            let _ = writeln!(
                out,
                "GPU_PROBE PANIC os={} (probe panicked; treated as no usable adapter)",
                std::env::consts::OS
            );
        }
    }
    let _ = out.flush();
}
