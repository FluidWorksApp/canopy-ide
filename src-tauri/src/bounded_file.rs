//! Stable-handle bounded reads for internal stores and parser inputs.

use std::io::Read;
use std::path::Path;

pub(crate) fn read(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let initial = file.metadata().map_err(|error| error.to_string())?.len();
    if initial > max as u64 {
        return Err(format!(
            "{} is {initial} bytes; the read limit is {max}",
            path.display()
        ));
    }
    let mut bytes = Vec::with_capacity((initial as usize).min(max));
    file.take(max.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > max {
        return Err(format!(
            "{} grew past the {max}-byte read limit",
            path.display()
        ));
    }
    Ok(bytes)
}

pub(crate) fn read_string(path: &Path, max: usize) -> Result<String, String> {
    String::from_utf8(read(path, max)?).map_err(|_| format!("{} is not UTF-8", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_a_whole_file_before_retaining_past_the_limit() {
        let path = std::env::temp_dir().join(format!("canopy-bounded-file-{}", std::process::id()));
        std::fs::write(&path, vec![b'x'; 17]).unwrap();
        assert!(read(&path, 16).unwrap_err().contains("read limit"));
        assert_eq!(read(&path, 17).unwrap().len(), 17);
        std::fs::remove_file(path).ok();
    }
}
