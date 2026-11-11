//! Byte-writing helpers. Everything appends to a caller-owned `Vec<u8>`; no
//! helper allocates beyond what the vector itself may need to grow.

pub(crate) const ESC: u8 = 0x1b;

/// Appends `ESC [`.
#[inline]
pub(crate) fn csi(out: &mut Vec<u8>) {
    out.extend_from_slice(b"\x1b[");
}

/// Appends `ESC O`.
#[inline]
pub(crate) fn ss3(out: &mut Vec<u8>) {
    out.extend_from_slice(b"\x1bO");
}

/// Appends `n` in decimal without going through `fmt`.
#[inline]
pub(crate) fn push_u32(out: &mut Vec<u8>, mut n: u32) {
    let mut tmp = [0u8; 10];
    let mut i = tmp.len();
    loop {
        i -= 1;
        tmp[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    out.extend_from_slice(&tmp[i..]);
}

/// Appends the UTF-8 encoding of `c`.
#[inline]
pub(crate) fn push_char(out: &mut Vec<u8>, c: char) {
    let mut tmp = [0u8; 4];
    out.extend_from_slice(c.encode_utf8(&mut tmp).as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_formatting_matches_std() {
        for n in [0u32, 1, 9, 10, 99, 100, 57344, 63743, u32::MAX] {
            let mut v = Vec::new();
            push_u32(&mut v, n);
            assert_eq!(v, n.to_string().into_bytes());
        }
    }

    #[test]
    fn chars_encode_as_utf8() {
        for c in ['a', 'é', '€', '😀'] {
            let mut v = Vec::new();
            push_char(&mut v, c);
            assert_eq!(v, c.to_string().into_bytes());
        }
    }
}
