//! Searching the transcript (scrollback and live screen) for text.
//!
//! [`line_matches`] and [`search_range`] are the pure matching. [`FindState`]
//! keeps the results current while output arrives without searching the whole
//! history again: lines that have scrolled into history never change, so they
//! are searched once and only new history lines and the live rows are searched
//! on later refreshes.
//!
//! Matching works on the scalars in the cells: a match covers whole cells (a
//! wide character, or a base with its combining marks, is never split), blank
//! space after the last character is not matched, and nothing is normalised
//! (a precomposed `é` does not match `e` plus a combining acute). Case folding
//! is Unicode simple lowercase. Soft wraps are not recorded in rows, so a
//! match cannot span a wrapped line break.

use canopy_term_core::frame::Attrs;
use canopy_term_core::Row;

use crate::lines::Lines;

/// Most matches kept; the rest are not searched for.
pub const MAX_MATCHES: usize = 10_000;
/// Lines fetched per engine round trip while searching.
const CHUNK: usize = 512;

/// One match: an absolute line (see [`crate::viewport`]) and the inclusive cell
/// columns it covers. Ordered by position.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Match {
    pub line: usize,
    pub start: u16,
    pub end: u16,
}

fn fold(c: char, case_sensitive: bool) -> char {
    if case_sensitive {
        return c;
    }
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

/// A row's scalars with the first and last cell column each one occupies.
fn row_chars(row: &Row) -> Vec<(char, u16, u16)> {
    let mut out = Vec::new();
    let n = row.cells.len();
    let mut col = 0;
    while col < n {
        let cell = &row.cells[col];
        if cell.attrs.has(Attrs::WIDE_TAIL) {
            col += 1;
            continue;
        }
        let cols = if row
            .cells
            .get(col + 1)
            .is_some_and(|c| c.attrs.has(Attrs::WIDE_TAIL))
        {
            2
        } else {
            1
        };
        let (first, last) = (col as u16, (col + cols - 1) as u16);
        if cell.attrs.has(Attrs::HIDDEN) || cell.ch == '\0' {
            out.push((' ', first, last));
        } else {
            match row.clusters.get(cell.cluster as usize) {
                Some(text) if cell.cluster != 0 => {
                    for ch in text.chars() {
                        out.push((ch, first, last));
                    }
                }
                _ => out.push((cell.ch, first, last)),
            }
        }
        col += cols;
    }
    while out.last().is_some_and(|(c, _, _)| *c == ' ') {
        out.pop();
    }
    out
}

fn folded_needle(needle: &str, case_sensitive: bool) -> Vec<char> {
    needle.chars().map(|c| fold(c, case_sensitive)).collect()
}

fn matches_in(row: &Row, needle: &[char], case_sensitive: bool) -> Vec<(u16, u16)> {
    let m = needle.len();
    if m == 0 {
        return Vec::new();
    }
    let hay = row_chars(row);
    let folded: Vec<char> = hay
        .iter()
        .map(|(c, _, _)| fold(*c, case_sensitive))
        .collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + m <= folded.len() {
        if folded[i..i + m] == *needle {
            out.push((hay[i].1, hay[i + m - 1].2));
            i += m;
        } else {
            i += 1;
        }
    }
    out
}

/// The non-overlapping matches of `needle` in one row, as inclusive cell
/// columns, left to right.
pub fn line_matches(row: &Row, needle: &str, case_sensitive: bool) -> Vec<(u16, u16)> {
    matches_in(row, &folded_needle(needle, case_sensitive), case_sensitive)
}

/// The matches on absolute lines `from .. to` (clamped to the transcript), in
/// reading order, at most `limit`. The flag is true when `limit` cut the list
/// short.
pub fn search_range(
    lines: &dyn Lines,
    from: usize,
    to: usize,
    needle: &str,
    case_sensitive: bool,
    limit: usize,
) -> (Vec<Match>, bool) {
    let needle = folded_needle(needle, case_sensitive);
    let mut out = Vec::new();
    if needle.is_empty() {
        return (out, false);
    }
    let to = to.min(lines.total());
    let mut start = from;
    while start < to {
        let count = CHUNK.min(to - start);
        let rows = lines.fetch(start, count);
        for (i, row) in rows.iter().enumerate() {
            for (s, e) in matches_in(row, &needle, case_sensitive) {
                if out.len() >= limit {
                    return (out, true);
                }
                out.push(Match {
                    line: start + i,
                    start: s,
                    end: e,
                });
            }
        }
        if rows.len() < count {
            break;
        }
        start += count;
    }
    (out, false)
}

/// The query, the options and the current results, kept up to date as output
/// arrives.
#[derive(Clone, Debug, Default)]
pub struct FindState {
    query: String,
    case_sensitive: bool,
    /// Matches in history lines `0 .. hist_searched`.
    hist: Vec<Match>,
    hist_searched: usize,
    hist_capped: bool,
    /// Matches on the live rows as of the last refresh.
    live: Vec<Match>,
    live_capped: bool,
    /// `hist` then `live`.
    all: Vec<Match>,
    current: Option<Match>,
}

impl FindState {
    pub fn query(&self) -> &str {
        &self.query
    }

    /// Sets the query. The results are stale until the next
    /// [`FindState::refresh`].
    pub fn set_query(&mut self, query: String) {
        if query != self.query {
            self.query = query;
            self.reset_cache();
        }
    }

    pub fn case_sensitive(&self) -> bool {
        self.case_sensitive
    }

    pub fn set_case_sensitive(&mut self, on: bool) {
        if on != self.case_sensitive {
            self.case_sensitive = on;
            self.reset_cache();
        }
    }

    /// Forgets searched history, so the next refresh searches everything
    /// (resize, alternate-screen switch, a new query). The current match is
    /// kept so it can be found again.
    pub fn reset_cache(&mut self) {
        self.hist.clear();
        self.hist_searched = 0;
        self.hist_capped = false;
        self.live.clear();
        self.live_capped = false;
        self.all.clear();
    }

    /// Brings the results up to date. `hist_len` is the number of history
    /// lines; the live rows are the lines after them. The current match moves
    /// to the first match at or after where it was if it is gone.
    pub fn refresh(&mut self, lines: &dyn Lines, hist_len: usize) {
        if self.query.is_empty() {
            self.reset_cache();
            self.current = None;
            return;
        }
        if hist_len < self.hist_searched {
            self.hist.clear();
            self.hist_searched = 0;
            self.hist_capped = false;
        }
        if hist_len > self.hist_searched && !self.hist_capped {
            let room = MAX_MATCHES.saturating_sub(self.hist.len());
            let (found, capped) = search_range(
                lines,
                self.hist_searched,
                hist_len,
                &self.query,
                self.case_sensitive,
                room,
            );
            self.hist.extend(found);
            self.hist_capped = capped;
            self.hist_searched = hist_len;
        }
        let room = MAX_MATCHES.saturating_sub(self.hist.len());
        let (live, capped) = search_range(
            lines,
            hist_len,
            lines.total(),
            &self.query,
            self.case_sensitive,
            room,
        );
        self.live = live;
        self.live_capped = capped;
        self.all.clear();
        self.all.extend_from_slice(&self.hist);
        self.all.extend_from_slice(&self.live);
        self.current = match self.current {
            Some(cur) => {
                let i = self.all.partition_point(|m| *m < cur);
                self.all.get(i).or(self.all.last()).copied()
            }
            None => None,
        };
    }

    /// Every match, in reading order.
    pub fn matches(&self) -> &[Match] {
        &self.all
    }

    /// True when the match limit cut the search short.
    pub fn capped(&self) -> bool {
        self.hist_capped || self.live_capped
    }

    pub fn current(&self) -> Option<Match> {
        self.current
    }

    /// 0-based position of the current match among all of them.
    pub fn current_index(&self) -> Option<usize> {
        self.all.binary_search(&self.current?).ok()
    }

    /// The matches on absolute lines `top .. top + rows`.
    pub fn visible(&self, top: usize, rows: u16) -> &[Match] {
        let lo = self.all.partition_point(|m| m.line < top);
        let hi = self
            .all
            .partition_point(|m| m.line < top.saturating_add(rows as usize));
        &self.all[lo..hi]
    }

    /// Chooses the first match to show: the last one at or above absolute line
    /// `view_bottom` (the newest output you can already see), else the first.
    pub fn pick_initial(&mut self, view_bottom: usize) {
        let i = self.all.partition_point(|m| m.line <= view_bottom);
        self.current = if i > 0 {
            self.all.get(i - 1).copied()
        } else {
            self.all.first().copied()
        };
    }

    /// Moves to the next match in reading order, wrapping to the first.
    pub fn next(&mut self) -> Option<Match> {
        if self.all.is_empty() {
            self.current = None;
            return None;
        }
        let i = match self.current {
            Some(c) => self
                .all
                .partition_point(|m| (m.line, m.start) <= (c.line, c.start)),
            None => 0,
        };
        self.current = self.all.get(i).or(self.all.first()).copied();
        self.current
    }

    /// Moves to the previous match, wrapping to the last.
    pub fn prev(&mut self) -> Option<Match> {
        if self.all.is_empty() {
            self.current = None;
            return None;
        }
        let i = match self.current {
            Some(c) => self
                .all
                .partition_point(|m| (m.line, m.start) < (c.line, c.start)),
            None => self.all.len(),
        };
        self.current = if i == 0 {
            self.all.last().copied()
        } else {
            self.all.get(i - 1).copied()
        };
        self.current
    }

    /// The result line of the find bar: empty without a query, `No matches`,
    /// or `3 of 12` (`12+` when the limit cut the search).
    pub fn status(&self) -> String {
        if self.query.is_empty() {
            return String::new();
        }
        let n = self.all.len();
        if n == 0 {
            return "No matches".to_string();
        }
        let plus = if self.capped() { "+" } else { "" };
        match self.current_index() {
            Some(i) => format!("{} of {n}{plus}", i + 1),
            None => format!("{n}{plus} matches"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_term_core::frame::Cell;
    use unicode_width::UnicodeWidthChar;

    fn row(text: &str, cols: usize) -> Row {
        let mut cells = vec![Cell::default(); cols];
        let mut clusters = vec![String::new()];
        let mut col = 0;
        let mut chars = text.chars().peekable();
        while let Some(c) = chars.next() {
            let w = c.width().unwrap_or(0);
            if w == 0 || col >= cols {
                continue;
            }
            let mut cluster = String::new();
            while let Some(&m) = chars.peek() {
                if m.width() == Some(0) {
                    if cluster.is_empty() {
                        cluster.push(c);
                    }
                    cluster.push(m);
                    chars.next();
                } else {
                    break;
                }
            }
            let idx = if cluster.is_empty() {
                0
            } else {
                clusters.push(cluster);
                (clusters.len() - 1) as u32
            };
            cells[col] = Cell {
                ch: c,
                cluster: idx,
                ..Cell::default()
            };
            if w == 2 && col + 1 < cols {
                cells[col + 1] = Cell {
                    ch: '\0',
                    attrs: Attrs(Attrs::WIDE_TAIL),
                    ..Cell::default()
                };
            }
            col += w;
        }
        Row { cells, clusters }
    }

    fn rows(lines: &[&str]) -> Vec<Row> {
        lines.iter().map(|l| row(l, 20)).collect()
    }

    #[test]
    fn matches_are_columns_left_to_right_and_do_not_overlap() {
        let r = row("abcabc aaaa", 20);
        assert_eq!(line_matches(&r, "bc", true), vec![(1, 2), (4, 5)]);
        assert_eq!(line_matches(&r, "aa", true), vec![(7, 8), (9, 10)]);
        assert_eq!(line_matches(&r, "zzz", true), vec![]);
        assert_eq!(line_matches(&r, "", true), vec![]);
    }

    #[test]
    fn case_can_be_ignored_or_respected() {
        let r = row("Error error ERROR", 20);
        assert_eq!(line_matches(&r, "error", false).len(), 3);
        assert_eq!(line_matches(&r, "error", true), vec![(6, 10)]);
        assert_eq!(line_matches(&r, "ERROR", true), vec![(12, 16)]);
        // Non-ASCII letters fold too.
        let r = row("ÉCOLE école", 20);
        assert_eq!(line_matches(&r, "école", false).len(), 2);
    }

    #[test]
    fn wide_characters_match_whole_cells_and_report_both_columns() {
        let r = row("a日本b", 10);
        // a0 日1-2 本3-4 b5
        assert_eq!(line_matches(&r, "日本", true), vec![(1, 4)]);
        assert_eq!(line_matches(&r, "本b", true), vec![(3, 5)]);
        assert_eq!(line_matches(&r, "日", true), vec![(1, 2)]);
    }

    #[test]
    fn combining_marks_match_as_part_of_their_cell() {
        let r = row("cafe\u{301} x", 10);
        // The cell at column 3 is "e" + acute; a needle with both matches it.
        assert_eq!(line_matches(&r, "cafe\u{301}", true), vec![(0, 3)]);
        // A needle ending at the base letter still covers the whole cell.
        assert_eq!(line_matches(&r, "caf", true), vec![(0, 2)]);
        assert_eq!(line_matches(&r, "afe", true), vec![(1, 3)]);
        // No normalisation: the precomposed form is different text.
        assert_eq!(line_matches(&r, "caf\u{e9}", true), vec![]);
    }

    #[test]
    fn trailing_blanks_are_not_searched_but_inner_spaces_are() {
        let r = row("a b   ", 10);
        assert_eq!(line_matches(&r, "a b", true), vec![(0, 2)]);
        assert_eq!(line_matches(&r, "b ", true), vec![]);
        assert_eq!(line_matches(&r, " ", true), vec![(1, 1)]);
    }

    #[test]
    fn hidden_cells_search_as_blanks() {
        let mut r = row("abc", 5);
        r.cells[1].attrs = Attrs(Attrs::HIDDEN);
        assert_eq!(line_matches(&r, "abc", true), vec![]);
        assert_eq!(line_matches(&r, "a c", true), vec![(0, 2)]);
    }

    #[test]
    fn a_range_search_covers_scrollback_and_live_rows_in_order() {
        let t = rows(&["foo one", "bar", "foo two foo", "baz"]);
        let (m, capped) = search_range(&t, 0, 4, "foo", true, 100);
        assert!(!capped);
        assert_eq!(
            m,
            vec![
                Match {
                    line: 0,
                    start: 0,
                    end: 2
                },
                Match {
                    line: 2,
                    start: 0,
                    end: 2
                },
                Match {
                    line: 2,
                    start: 8,
                    end: 10
                },
            ]
        );
        // A sub-range, and a range past the end.
        assert_eq!(search_range(&t, 1, 3, "foo", true, 100).0.len(), 2);
        assert_eq!(search_range(&t, 2, 99, "foo", true, 100).0.len(), 2);
        assert!(search_range(&t, 9, 99, "foo", true, 100).0.is_empty());
        assert!(search_range(&t, 0, 4, "", true, 100).0.is_empty());
    }

    #[test]
    fn the_match_limit_cuts_the_search_and_says_so() {
        let t = rows(&["aaaa", "aaaa"]);
        let (m, capped) = search_range(&t, 0, 2, "a", true, 5);
        assert_eq!(m.len(), 5);
        assert!(capped);
        let (m, capped) = search_range(&t, 0, 2, "a", true, 8);
        assert_eq!(m.len(), 8);
        assert!(!capped, "exactly at the limit is not cut");
    }

    #[test]
    fn a_long_transcript_is_searched_in_chunks() {
        let lines: Vec<String> = (0..1500).map(|i| format!("line {i}")).collect();
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let t = rows(&refs);
        let (m, _) = search_range(&t, 0, 1500, "line 14", true, 10_000);
        // line 14, line 140-149, line 1400-1499.
        assert_eq!(m.len(), 1 + 10 + 100);
        assert!(m.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(m.last().unwrap().line, 1499);
    }

    fn state_over(t: &Vec<Row>, hist: usize, query: &str) -> FindState {
        let mut s = FindState::default();
        s.set_query(query.to_string());
        s.refresh(t, hist);
        s
    }

    #[test]
    fn next_and_previous_walk_the_matches_and_wrap() {
        let t = rows(&["x", "foo", "foo foo", "y"]);
        let mut s = state_over(&t, 2, "foo");
        assert_eq!(s.matches().len(), 3);
        assert_eq!(s.current(), None);
        s.pick_initial(2);
        assert_eq!(s.current().unwrap().line, 2);
        assert_eq!(
            s.current().unwrap().start,
            4,
            "the last match at or above the bottom"
        );
        assert_eq!(s.status(), "3 of 3");
        let n = s.next().unwrap();
        assert_eq!((n.line, n.start), (1, 0), "wraps to the first");
        assert_eq!(s.status(), "1 of 3");
        assert_eq!(s.next().unwrap().line, 2);
        assert_eq!(s.prev().unwrap().line, 1);
        let p = s.prev().unwrap();
        assert_eq!((p.line, p.start), (2, 4), "wraps to the last");
    }

    #[test]
    fn with_no_current_match_next_is_first_and_previous_is_last() {
        let t = rows(&["foo", "foo"]);
        let mut s = state_over(&t, 0, "foo");
        assert_eq!(s.next().unwrap().line, 0);
        let mut s = state_over(&t, 0, "foo");
        assert_eq!(s.prev().unwrap().line, 1);
    }

    #[test]
    fn pick_initial_prefers_the_newest_visible_then_the_first() {
        let t = rows(&["foo", "a", "foo", "b", "foo"]);
        let mut s = state_over(&t, 0, "foo");
        s.pick_initial(3);
        assert_eq!(s.current().unwrap().line, 2);
        // Nothing at or above: the first match below.
        let t = rows(&["a", "a", "foo"]);
        let mut s = state_over(&t, 0, "foo");
        s.pick_initial(0);
        assert_eq!(s.current().unwrap().line, 2);
    }

    #[test]
    fn no_matches_and_empty_query_have_their_own_status() {
        let t = rows(&["abc"]);
        let mut s = state_over(&t, 0, "zzz");
        assert_eq!(s.status(), "No matches");
        assert_eq!(s.next(), None);
        assert_eq!(s.prev(), None);
        let s = state_over(&t, 0, "");
        assert_eq!(s.status(), "");
        assert!(s.matches().is_empty());
    }

    #[test]
    fn the_status_marks_a_capped_search() {
        let lines = vec!["a".repeat(20); 600];
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let t = rows(&refs);
        let mut s = state_over(&t, 0, "a");
        assert_eq!(s.matches().len(), MAX_MATCHES);
        assert!(s.capped());
        s.pick_initial(0);
        assert!(s.status().ends_with("of 10000+"), "{}", s.status());
    }

    #[test]
    fn visible_matches_are_those_on_screen_lines() {
        let t = rows(&["foo", "foo", "x", "foo", "foo"]);
        let s = state_over(&t, 0, "foo");
        let v = s.visible(1, 3);
        assert_eq!(v.iter().map(|m| m.line).collect::<Vec<_>>(), vec![1, 3]);
        assert!(s.visible(10, 5).is_empty());
        assert_eq!(s.visible(0, 100).len(), 4);
    }

    #[test]
    fn refresh_searches_only_new_history_and_keeps_the_current_match() {
        // Two history lines and two live rows, then one live row scrolls into
        // history and a new one arrives.
        let before = rows(&["foo a", "b", "foo c", "d"]);
        let mut s = state_over(&before, 2, "foo");
        s.pick_initial(2);
        let cur = s.current().unwrap();
        assert_eq!(cur.line, 2);
        let after = rows(&["foo a", "b", "foo c", "d", "foo e"]);
        s.refresh(&after, 3);
        assert_eq!(s.matches().len(), 3);
        assert_eq!(s.current(), Some(cur), "absolute lines keep their text");
        assert_eq!(s.status(), "2 of 3");
    }

    #[test]
    fn a_vanished_current_match_moves_to_the_next_one() {
        let before = rows(&["foo", "foo", "foo"]);
        let mut s = state_over(&before, 0, "foo");
        s.pick_initial(1);
        assert_eq!(s.current().unwrap().line, 1);
        // The program rewrote line 1.
        let after = rows(&["foo", "bar", "foo"]);
        s.refresh(&after, 0);
        assert_eq!(s.current().unwrap().line, 2);
        // And when nothing at or after is left, the last one.
        let gone = rows(&["foo", "bar", "baz"]);
        s.refresh(&gone, 0);
        assert_eq!(s.current().unwrap().line, 0);
    }

    #[test]
    fn a_shrinking_history_is_searched_again() {
        let t = rows(&["foo", "x", "foo", "y"]);
        let mut s = state_over(&t, 3, "foo");
        assert_eq!(s.matches().len(), 2);
        // History reflowed to fewer lines.
        let t2 = rows(&["foo", "y"]);
        s.refresh(&t2, 1);
        assert_eq!(s.matches().len(), 1);
    }

    #[test]
    fn changing_the_query_or_case_searches_again() {
        let t = rows(&["Foo foo"]);
        // Case is ignored unless asked for.
        let mut s = state_over(&t, 0, "foo");
        assert_eq!(s.matches().len(), 2);
        s.set_case_sensitive(true);
        s.refresh(&t, 0);
        assert_eq!(s.matches().len(), 1);
        s.set_query("Foo".into());
        s.refresh(&t, 0);
        assert_eq!(s.matches().len(), 1);
        s.set_case_sensitive(false);
        s.set_query("foo".into());
        s.refresh(&t, 0);
        assert_eq!(s.matches().len(), 2);
        s.set_query(String::new());
        s.refresh(&t, 0);
        assert!(s.matches().is_empty());
        assert_eq!(s.current(), None);
    }
}
