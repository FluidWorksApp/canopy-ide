//! Reading the times an agent or a form sends into an instant.
//!
//! No date library in the tree, and adding one for two conversions would be the
//! larger change. What is needed is small and exactly specified: civil date to
//! epoch (pure arithmetic), epoch to *local* civil fields, and a parser for the
//! handful of shapes an agent or a form will send.

/// Days from 1970-01-01 to a proleptic-Gregorian y/m/d. Howard Hinnant's
/// `days_from_civil`, which is exact for every date this will ever see and has
/// no table, no leap-second and no locale in it.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

/// A wall-clock date and time with no timezone attached yet.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Civil {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
}

impl Civil {
    fn valid(&self) -> bool {
        self.month >= 1
            && self.month <= 12
            && self.day >= 1
            && self.day <= days_in_month(self.year, self.month)
            && self.hour >= 0
            && self.hour <= 23
            && self.minute >= 0
            && self.minute <= 59
    }

    /// Seconds since the epoch, reading these fields as UTC.
    pub fn to_utc_epoch(self) -> i64 {
        days_from_civil(self.year, self.month, self.day) * 86_400
            + self.hour * 3_600
            + self.minute * 60
    }
}

/// Epoch seconds → the local wall clock, which is the only calendar launchd
/// speaks. `localtime_r` rather than an offset we computed once: the whole
/// point is a time months away, and "months away" is exactly where a fixed
/// offset gets daylight saving wrong by an hour.
#[cfg(unix)]
pub fn local_civil(ts: i64) -> Option<Civil> {
    let t = ts as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::localtime_r(&t, &mut tm) }.is_null() {
        return None;
    }
    Some(Civil {
        year: tm.tm_year as i64 + 1900,
        month: tm.tm_mon as i64 + 1,
        day: tm.tm_mday as i64,
        hour: tm.tm_hour as i64,
        minute: tm.tm_min as i64,
    })
}

#[cfg(not(unix))]
pub fn local_civil(_ts: i64) -> Option<Civil> {
    None
}

/// A local wall-clock time → epoch seconds. `mktime` resolves it against the
/// zone *and the DST rules in force on that date*, and answers for the
/// ambiguous hour a fall-back repeats rather than refusing.
#[cfg(unix)]
fn local_epoch(c: Civil) -> Option<i64> {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = (c.year - 1900) as libc::c_int;
    tm.tm_mon = (c.month - 1) as libc::c_int;
    tm.tm_mday = c.day as libc::c_int;
    tm.tm_hour = c.hour as libc::c_int;
    tm.tm_min = c.minute as libc::c_int;
    tm.tm_sec = 0;
    // "Work it out": without this, a zeroed tm claims standard time and a
    // summer reminder lands an hour early.
    tm.tm_isdst = -1;
    let t = unsafe { libc::mktime(&mut tm) };
    if t == -1 {
        None
    } else {
        Some(t as i64)
    }
}

#[cfg(not(unix))]
fn local_epoch(_c: Civil) -> Option<i64> {
    None
}

/// `30m`, `2h`, `3d`, `1w`, or several run together (`1h30m`). Returns seconds.
fn parse_duration(raw: &str) -> Option<i64> {
    let s = raw.trim().to_ascii_lowercase();
    let s = s.strip_prefix("in ").unwrap_or(&s).trim();
    if s.is_empty() {
        return None;
    }
    let mut total = 0i64;
    let mut num = String::new();
    let mut saw = false;
    for ch in s.chars() {
        if ch.is_ascii_digit() {
            num.push(ch);
            continue;
        }
        if ch == ' ' {
            continue;
        }
        let n: i64 = num.parse().ok()?;
        num.clear();
        let unit = match ch {
            'm' => 60,
            'h' => 3_600,
            'd' => 86_400,
            'w' => 604_800,
            _ => return None,
        };
        total += n.checked_mul(unit)?;
        saw = true;
    }
    // A bare number is minutes — the unit anyone means by "remind me in 20".
    if !num.is_empty() {
        total += num.parse::<i64>().ok()? * 60;
        saw = true;
    }
    if saw && total > 0 {
        Some(total)
    } else {
        None
    }
}

/// The hour a date with no time means. Someone writing "Friday" means the
/// working day, not the stroke of midnight that technically starts it.
pub const DATE_ONLY_HOUR: i64 = 9;

/// How far out a reminder may be set. Not a technical limit — a decade-long
/// launchd job is a thing nobody meant to create, and it is nearly always a
/// unit mix-up (milliseconds handed to a seconds field) rather than a plan.
const MAX_AHEAD: i64 = 5 * 365 * 86_400;

/// Turn what a caller sent into an instant.
///
/// Accepts, in the order an agent is likely to reach for them:
///   - `in`: a duration from now — `45m`, `2h`, `3d`, `1w`, `1h30m`
///   - `at`: epoch seconds (a JSON number, or its digits as a string)
///   - `at`: `2026-08-03T09:00:00Z` or `…+05:30` — an exact instant
///   - `at`: `2026-08-03T09:00` — local wall clock, resolved here
///   - `at`: `2026-08-03` — that date at 09:00 local
///
/// Errors name the shapes rather than saying "invalid", because the caller is
/// often a model that will get it right on the second try if told how.
pub fn parse_when(at: Option<&str>, within: Option<&str>, now: i64) -> Result<i64, String> {
    if let Some(raw) = within.map(str::trim).filter(|s| !s.is_empty()) {
        let secs = parse_duration(raw)
            .ok_or_else(|| format!("couldn't read \"{raw}\" as a delay — try 45m, 2h, 3d or 1w"))?;
        return check(now + secs, now);
    }
    let raw = at
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("a reminder needs a time — `at` (2026-08-03T09:00) or `in` (2h)")?;

    // Epoch seconds, the shape the UI sends and the least ambiguous of all.
    if raw.chars().all(|c| c.is_ascii_digit()) && raw.len() >= 9 {
        let secs: i64 = raw
            .parse()
            .map_err(|_| format!("{raw} is not a time I can read"))?;
        return check(secs, now);
    }

    let (stamp, zone) = split_zone(raw);
    let civil = parse_civil(stamp)?;
    if !civil.valid() {
        return Err(format!("{raw} is not a real date and time"));
    }
    let secs = match zone {
        Some(offset) => civil.to_utc_epoch() - offset,
        None => local_epoch(civil).ok_or_else(|| {
            format!(
                "{raw} has no timezone and this platform can't resolve local time — \
                 send it as 2026-08-03T09:00:00Z, with an offset, or use `in`"
            )
        })?,
    };
    check(secs, now)
}

fn check(secs: i64, now: i64) -> Result<i64, String> {
    if secs <= now {
        return Err(format!(
            "that time has already passed ({} seconds ago) — a reminder has to be \
             in the future",
            now - secs
        ));
    }
    if secs - now > MAX_AHEAD {
        return Err("that is more than five years out — check the units".into());
    }
    Ok(secs)
}

/// Split a trailing `Z` or `±HH:MM` off, returning the offset in seconds east
/// of UTC. `None` means the stamp carried no zone and is a local wall clock.
fn split_zone(raw: &str) -> (&str, Option<i64>) {
    if let Some(rest) = raw.strip_suffix('Z').or_else(|| raw.strip_suffix('z')) {
        return (rest, Some(0));
    }
    // Only after the time part: the date's own dashes must not be read as one.
    let bytes = raw.as_bytes();
    for i in (1..bytes.len()).rev() {
        let c = bytes[i] as char;
        if c == '+' || c == '-' {
            // A leading `-` inside the date (positions < 11) is a separator.
            if i < 11 {
                break;
            }
            let (head, tail) = raw.split_at(i);
            let sign = if tail.starts_with('-') { -1 } else { 1 };
            let hm = &tail[1..];
            let (h, m) = match hm.split_once(':') {
                Some((h, m)) => (h, m),
                None if hm.len() == 4 => (&hm[..2], &hm[2..]),
                None => (hm, "0"),
            };
            let (Ok(h), Ok(m)) = (h.parse::<i64>(), m.parse::<i64>()) else {
                break;
            };
            return (head, Some(sign * (h * 3_600 + m * 60)));
        }
        if c == 'T' || c == 't' {
            break;
        }
    }
    (raw, None)
}

fn parse_civil(stamp: &str) -> Result<Civil, String> {
    let bad = || {
        format!(
            "couldn't read \"{stamp}\" as a time — use 2026-08-03T09:00, \
             2026-08-03T09:00:00Z, or just 2026-08-03"
        )
    };
    let (date, time) = match stamp.split_once(['T', 't', ' ']) {
        Some((d, t)) => (d, Some(t)),
        None => (stamp, None),
    };
    let mut parts = date.split('-');
    let (Some(y), Some(mo), Some(d), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(bad());
    };
    let (Ok(year), Ok(month), Ok(day)) = (y.parse::<i64>(), mo.parse::<i64>(), d.parse::<i64>())
    else {
        return Err(bad());
    };
    let (hour, minute) = match time.map(str::trim).filter(|t| !t.is_empty()) {
        None => (DATE_ONLY_HOUR, 0),
        Some(t) => {
            let mut tp = t.split(':');
            let (Some(h), m) = (tp.next(), tp.next()) else {
                return Err(bad());
            };
            let (Ok(hour), Ok(minute)) = (h.parse::<i64>(), m.unwrap_or("0").parse::<i64>()) else {
                return Err(bad());
            };
            (hour, minute)
        }
    };
    Ok(Civil {
        year,
        month,
        day,
        hour,
        minute,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_785_000_000; // 2026-07-25T17:20:00Z, a Saturday.

    #[test]
    fn civil_epoch_round_trips_the_landmarks() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
        assert_eq!(
            Civil {
                year: 2026,
                month: 8,
                day: 3,
                hour: 9,
                minute: 0
            }
            .to_utc_epoch(),
            1_785_747_600
        );
    }

    #[test]
    fn reads_a_duration_in_the_shapes_people_write() {
        assert_eq!(parse_when(None, Some("45m"), NOW), Ok(NOW + 2_700));
        assert_eq!(parse_when(None, Some("2h"), NOW), Ok(NOW + 7_200));
        assert_eq!(parse_when(None, Some("3d"), NOW), Ok(NOW + 259_200));
        assert_eq!(parse_when(None, Some("1w"), NOW), Ok(NOW + 604_800));
        assert_eq!(parse_when(None, Some("1h30m"), NOW), Ok(NOW + 5_400));
        assert_eq!(parse_when(None, Some("in 2h"), NOW), Ok(NOW + 7_200));
        // A bare number is minutes, which is what "remind me in 20" means.
        assert_eq!(parse_when(None, Some("20"), NOW), Ok(NOW + 1_200));
    }

    #[test]
    fn reads_an_instant_when_the_zone_is_explicit() {
        assert_eq!(
            parse_when(Some("2026-08-03T09:00:00Z"), None, NOW),
            Ok(1_785_747_600)
        );
        // +05:30 means the same wall clock happens 5h30 earlier in UTC.
        assert_eq!(
            parse_when(Some("2026-08-03T09:00+05:30"), None, NOW),
            Ok(1_785_747_600 - 19_800)
        );
        assert_eq!(
            parse_when(Some("2026-08-03T09:00-0400"), None, NOW),
            Ok(1_785_747_600 + 14_400)
        );
    }

    #[test]
    fn epoch_seconds_pass_straight_through() {
        assert_eq!(parse_when(Some("1785747600"), None, NOW), Ok(1_785_747_600));
    }

    #[test]
    fn a_bare_date_means_the_working_morning_not_midnight() {
        // Local, so assert the civil fields rather than the instant — the test
        // has to pass in every timezone CI might run in.
        let secs = parse_when(Some("2026-08-03"), None, NOW).unwrap();
        let c = local_civil(secs).unwrap();
        assert_eq!((c.year, c.month, c.day), (2026, 8, 3));
        assert_eq!((c.hour, c.minute), (DATE_ONLY_HOUR, 0));
    }

    #[test]
    fn a_local_wall_clock_lands_on_that_wall_clock() {
        let secs = parse_when(Some("2026-08-03T14:45"), None, NOW).unwrap();
        let c = local_civil(secs).unwrap();
        assert_eq!((c.hour, c.minute), (14, 45));
    }

    #[test]
    fn refuses_a_time_that_has_gone_and_says_so() {
        let err = parse_when(Some("2020-01-01T09:00:00Z"), None, NOW).unwrap_err();
        assert!(err.contains("already passed"), "{err}");
        let err = parse_when(None, None, NOW).unwrap_err();
        assert!(err.contains("needs a time"), "{err}");
        // Milliseconds handed to a seconds field — the mix-up the cap is for.
        let err = parse_when(Some("1785142800000"), None, NOW).unwrap_err();
        assert!(err.contains("five years"), "{err}");
    }

    #[test]
    fn refuses_a_date_that_does_not_exist() {
        assert!(parse_when(Some("2026-02-30T09:00:00Z"), None, NOW).is_err());
        assert!(parse_when(Some("2026-13-01T09:00:00Z"), None, NOW).is_err());
        assert!(parse_when(Some("next tuesday"), None, NOW).is_err());
        assert!(parse_when(None, Some("soon"), NOW).is_err());
    }

    #[test]
    fn the_date_separator_is_never_read_as_a_zone() {
        let (stamp, zone) = split_zone("2026-08-03T09:00");
        assert_eq!(stamp, "2026-08-03T09:00");
        assert_eq!(zone, None);
    }
}
