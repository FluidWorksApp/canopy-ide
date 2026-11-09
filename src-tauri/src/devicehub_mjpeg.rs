//! MJPEG still-frame re-send for the device hub proxy.
//!
//! Ported from T3 Code `apps/server/src/device/mjpegStillFrame.ts`
//! (https://github.com/pingdotgg/t3code, commit d5290e9, MIT License,
//! Copyright (c) 2026 T3 Tools Inc.). Behaviour is kept identical; the differences
//! are Rust-for-Effect ones and are commented where they occur.
//!
//! Browsers paint a multipart/x-mixed-replace part only once the next part
//! begins, and the hub writes a part only when the screen changes. Left alone,
//! an `<img>` viewer never shows a still screen and always hides the last frame
//! of a change. Re-sending the last part after a short quiet period makes it
//! paint.

use std::time::Duration;

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};

pub(crate) const STILL_FRAME_DELAY: Duration = Duration::from_millis(100);

const HEADER_END: &[u8] = b"\r\n\r\n";
const MAX_HEADER_BYTES: usize = 16 * 1024;
// Simulator frames are far smaller; a larger claim is unknown framing, not
// something to retain.
const MAX_PART_BYTES: u64 = 16 * 1024 * 1024;

/// `Content-Length` of a part header, when the header is the hub's framing.
fn part_length(headers: &str) -> Option<usize> {
    use std::sync::OnceLock;
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    if !headers.starts_with("--") {
        return None;
    }
    // T3: /^content-length:\s*(\d+)\s*$/im. `[0-9]` because JS `\d` is ASCII
    // only and the regex crate's is Unicode.
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"(?im)^content-length:\s*([0-9]+)\s*$").expect("static regex")
    });
    let digits = re.captures(headers)?.get(1)?.as_str();
    // `Number(...)` of an absurd digit string is a huge float; it fails the
    // bound either way, as an overflowing parse does here.
    let length: u64 = digits.parse().ok()?;
    (length <= MAX_PART_BYTES).then_some(length as usize)
}

fn ends_with_crlf(part: &[Bytes]) -> bool {
    let Some(last) = part.last() else {
        return false;
    };
    let cr = if last.len() > 1 {
        last.get(last.len() - 2).copied()
    } else {
        part.len()
            .checked_sub(2)
            .and_then(|i| part.get(i))
            .and_then(|piece| piece.last().copied())
    };
    cr == Some(0x0d) && last.last().copied() == Some(0x0a)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Follows the hub's part framing (`--frame`, `Content-Length`, CRLF CRLF,
/// body, CRLF; each part is one write) and keeps the last complete part as
/// views into the forwarded chunks (`Bytes` slices share the chunk), so frame
/// bytes are never copied. Any other framing turns tracking off and the rest
/// passes through.
#[derive(Default)]
pub(crate) struct PartTracker {
    pieces: Vec<Bytes>,
    size: usize,
    part_end: Option<usize>,
    tracking_off: bool,
    /// The last complete part, while the stream sits at a part boundary.
    pub(crate) still: Option<Vec<Bytes>>,
}

impl PartTracker {
    #[cfg(test)]
    pub(crate) fn tracking(&self) -> bool {
        !self.tracking_off
    }

    pub(crate) fn feed(&mut self, chunk: &Bytes) {
        if self.tracking_off {
            return;
        }
        let mut rest = chunk.clone();
        let mut part: Option<Vec<Bytes>> = None;
        while !rest.is_empty() {
            let part_end = match self.part_end {
                Some(end) => end,
                None => {
                    // A header split across chunks is re-scanned per chunk. Only
                    // a header-sized prefix of the new chunk joins the scan, so
                    // frame bytes are never copied.
                    let head: Bytes = if self.size == 0 {
                        rest.clone()
                    } else {
                        let take = rest.len().min(MAX_HEADER_BYTES + HEADER_END.len());
                        let mut joined = Vec::with_capacity(self.size + take);
                        for piece in &self.pieces {
                            joined.extend_from_slice(piece);
                        }
                        joined.extend_from_slice(&rest[..take]);
                        Bytes::from(joined)
                    };
                    let header_end = find(&head, HEADER_END);
                    if header_end.is_none() && head.len() <= MAX_HEADER_BYTES {
                        self.size += rest.len();
                        self.pieces.push(rest);
                        break;
                    }
                    let length = match header_end {
                        Some(end) if end <= MAX_HEADER_BYTES => {
                            // Buffer.toString("latin1"): one char per byte.
                            let text: String = head[..end].iter().map(|&b| b as char).collect();
                            part_length(&text)
                        }
                        _ => None,
                    };
                    let (Some(end), Some(length)) = (header_end, length) else {
                        self.tracking_off = true;
                        break;
                    };
                    let part_end = end + HEADER_END.len() + length + 2;
                    self.part_end = Some(part_end);
                    part_end
                }
            };
            let take = rest.len().min(part_end.saturating_sub(self.size));
            let taken = rest.slice(..take);
            self.size += taken.len();
            self.pieces.push(taken);
            rest = rest.slice(take..);
            if self.size < part_end {
                break;
            }
            let complete = std::mem::take(&mut self.pieces);
            if complete.is_empty() || !ends_with_crlf(&complete) {
                self.tracking_off = true;
                break;
            }
            part = Some(complete);
            self.size = 0;
            self.part_end = None;
        }
        if self.tracking_off {
            self.pieces.clear();
        }
        self.still = if !self.tracking_off && self.size == 0 {
            part.or_else(|| self.still.take())
        } else {
            None
        };
    }
}

fn join(part: &[Bytes]) -> Bytes {
    if part.len() == 1 {
        return part[0].clone();
    }
    let mut out = Vec::with_capacity(part.iter().map(Bytes::len).sum());
    for piece in part {
        out.extend_from_slice(piece);
    }
    Bytes::from(out)
}

/// Re-sends the latest frame once when the stream goes quiet between frames.
///
/// T3 forks the pending pull into a fiber and times out the join, so a frame
/// arriving mid-wait is kept. `StreamExt::next` is cancel-safe (an item is
/// only taken when `poll_next` returns it), so timing out `next()` and polling
/// again later keeps that same guarantee without a background task.
///
/// T3 yields the retained part as its original chunk views; an axum body takes
/// one `Bytes` per item, so the repeat joins them (one copy per re-send, never
/// per forwarded frame).
pub(crate) fn repeat_still_frame<S, E>(body: S) -> impl Stream<Item = Result<Bytes, E>> + Send
where
    S: Stream<Item = Result<Bytes, E>> + Send + Unpin + 'static,
    E: Send + 'static,
{
    repeat_still_frame_after(body, STILL_FRAME_DELAY)
}

pub(crate) fn repeat_still_frame_after<S, E>(
    body: S,
    delay: Duration,
) -> impl Stream<Item = Result<Bytes, E>> + Send
where
    S: Stream<Item = Result<Bytes, E>> + Send + Unpin + 'static,
    E: Send + 'static,
{
    futures_util::stream::unfold(
        (body, PartTracker::default()),
        move |(mut body, mut tracker)| async move {
            let forward = |item: Option<Result<Bytes, E>>, tracker: &mut PartTracker| {
                if let Some(Ok(chunk)) = &item {
                    tracker.feed(chunk);
                }
                item
            };
            let item = match tracker.still.clone() {
                None => forward(body.next().await, &mut tracker),
                Some(still) => match tokio::time::timeout(delay, body.next()).await {
                    Ok(next) => forward(next, &mut tracker),
                    Err(_) => {
                        tracker.still = None;
                        Some(Ok(join(&still)))
                    }
                },
            };
            item.map(|item| (item, (body, tracker)))
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    type Tx = tokio::sync::mpsc::UnboundedSender<Result<Bytes, ()>>;

    /// A test body the test feeds by hand.
    fn channel() -> (
        Tx,
        impl Stream<Item = Result<Bytes, ()>> + Send + Unpin + 'static,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let stream = futures_util::stream::unfold(rx, |mut rx| async move {
            rx.recv().await.map(|item| (item, rx))
        });
        (tx, Box::pin(stream))
    }

    fn part(body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out.extend_from_slice(b"\r\n");
        out
    }

    #[test]
    fn devicehub_mjpeg_tracks_a_whole_part_written_at_once() {
        let mut t = PartTracker::default();
        let p = part(b"JPEGDATA");
        t.feed(&Bytes::from(p.clone()));
        assert!(t.tracking());
        assert_eq!(join(t.still.as_ref().unwrap()), Bytes::from(p));
    }

    #[test]
    fn devicehub_mjpeg_reassembles_a_part_split_mid_header_and_mid_body() {
        let mut t = PartTracker::default();
        let p = part(b"0123456789abcdef");
        t.feed(&Bytes::copy_from_slice(&p[..10]));
        assert!(t.still.is_none(), "inside a part there is no still");
        t.feed(&Bytes::copy_from_slice(&p[10..60]));
        assert!(t.still.is_none());
        t.feed(&Bytes::copy_from_slice(&p[60..]));
        assert_eq!(join(t.still.as_ref().unwrap()), Bytes::from(p.clone()));
        // The next part replaces it, and two parts in one chunk keep the last.
        let q = part(b"second");
        let r = part(b"third");
        let mut both = q.clone();
        both.extend_from_slice(&r);
        t.feed(&Bytes::from(both));
        assert_eq!(join(t.still.as_ref().unwrap()), Bytes::from(r));
    }

    #[test]
    fn devicehub_mjpeg_unknown_framing_turns_tracking_off() {
        let mut t = PartTracker::default();
        t.feed(&Bytes::from_static(b"HTTP-ish garbage\r\n\r\nbody"));
        assert!(!t.tracking());
        assert!(t.still.is_none());
        // And stays off even for a valid part afterwards.
        t.feed(&Bytes::from(part(b"x")));
        assert!(t.still.is_none());
    }

    #[test]
    fn devicehub_mjpeg_oversized_content_length_is_not_retained() {
        let mut t = PartTracker::default();
        t.feed(&Bytes::from_static(
            b"--frame\r\nContent-Length: 99999999999\r\n\r\nabc",
        ));
        assert!(!t.tracking());
        assert_eq!(
            part_length("--frame\r\ncontent-length: 16777216\r\n"),
            Some(16_777_216)
        );
        assert_eq!(part_length("--frame\r\ncontent-length: 16777217\r\n"), None);
        assert_eq!(part_length("frame\r\ncontent-length: 1\r\n"), None);
    }

    #[test]
    fn devicehub_mjpeg_a_part_not_ending_in_crlf_turns_tracking_off() {
        let mut t = PartTracker::default();
        let mut bad = b"--frame\r\nContent-Length: 3\r\n\r\nabcXY".to_vec();
        bad.extend_from_slice(b"--frame");
        t.feed(&Bytes::from(bad));
        assert!(!t.tracking());
    }

    #[test]
    fn devicehub_mjpeg_crlf_split_across_pieces_is_recognised() {
        let p = part(b"abc");
        let n = p.len();
        let pieces = vec![
            Bytes::copy_from_slice(&p[..n - 1]),
            Bytes::copy_from_slice(&p[n - 1..]),
        ];
        assert!(ends_with_crlf(&pieces));
    }

    #[tokio::test]
    async fn devicehub_mjpeg_resends_the_last_part_once_after_a_quiet_period() {
        let (tx, rx) = channel();
        let mut out = Box::pin(repeat_still_frame_after(rx, Duration::from_millis(30)));
        let p = Bytes::from(part(b"frame-1"));
        tx.send(Ok(p.clone())).unwrap();
        assert_eq!(out.next().await.unwrap().unwrap(), p);
        // Quiet: the same part comes again, exactly once.
        assert_eq!(out.next().await.unwrap().unwrap(), p);
        let waited = tokio::time::timeout(Duration::from_millis(120), out.next()).await;
        assert!(waited.is_err(), "a still is re-sent once, not repeatedly");
        // A frame arriving later is forwarded untouched, then re-sent once.
        let q = Bytes::from(part(b"frame-2"));
        tx.send(Ok(q.clone())).unwrap();
        assert_eq!(out.next().await.unwrap().unwrap(), q);
        assert_eq!(out.next().await.unwrap().unwrap(), q);
        drop(tx);
        assert!(out.next().await.is_none());
    }

    #[tokio::test]
    async fn devicehub_mjpeg_a_frame_inside_the_quiet_window_is_not_lost() {
        let (tx, rx) = channel();
        let mut out = Box::pin(repeat_still_frame_after(rx, Duration::from_millis(200)));
        let p = Bytes::from(part(b"a"));
        let q = Bytes::from(part(b"b"));
        tx.send(Ok(p.clone())).unwrap();
        assert_eq!(out.next().await.unwrap().unwrap(), p);
        tx.send(Ok(q.clone())).unwrap();
        // q arrives before the delay, so it is forwarded instead of a repeat of p.
        assert_eq!(out.next().await.unwrap().unwrap(), q);
    }

    #[tokio::test]
    async fn devicehub_mjpeg_mid_part_silence_does_not_resend() {
        let (tx, rx) = channel();
        let mut out = Box::pin(repeat_still_frame_after(rx, Duration::from_millis(20)));
        let p = part(b"0123456789");
        tx.send(Ok(Bytes::copy_from_slice(&p[..20]))).unwrap();
        assert_eq!(out.next().await.unwrap().unwrap().len(), 20);
        let waited = tokio::time::timeout(Duration::from_millis(80), out.next()).await;
        assert!(
            waited.is_err(),
            "no still exists mid-part, so nothing is repeated"
        );
    }
}
