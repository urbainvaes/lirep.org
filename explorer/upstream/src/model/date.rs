use std::{
    cmp::{Ordering, min},
    convert::TryFrom,
    fmt,
    num::NonZeroU8,
    str::FromStr,
};

use thiserror::Error;
use time::{OffsetDateTime, PrimitiveDateTime};

#[derive(Error, Debug)]
pub enum InvalidDate {
    #[error("invlaid year")]
    InvalidYear,
    #[error("invalid month")]
    InvalidMonth,
}

#[derive(Copy, Clone, Debug)]
pub struct LaxDate {
    year: Year,
    month: Option<NonZeroU8>,
    day: Option<NonZeroU8>,
}

impl LaxDate {
    pub fn year(self) -> Year {
        self.year
    }

    pub fn month(self) -> Option<Month> {
        self.month
            .map(|m| Month(self.year.0 * 12 + u16::from(m.get()) - 1))
    }

    pub fn tomorrow() -> LaxDate {
        let utc_date = OffsetDateTime::now_utc()
            .date()
            .next_day()
            .expect("before max date");
        LaxDate {
            year: Year::try_from(u16::try_from(utc_date.year()).expect("not after u16::MAX"))
                .expect("not after MAX_YEAR"),
            month: Some(NonZeroU8::new(u8::from(utc_date.month())).expect("1-based month")),
            day: Some(NonZeroU8::new(utc_date.day()).expect("1-based day")),
        }
    }
}

impl FromStr for LaxDate {
    type Err = InvalidDate;

    fn from_str(s: &str) -> Result<LaxDate, InvalidDate> {
        let mut parts = s.splitn(3, '.');
        let year_part = parts.next().expect("non-empty split");
        Ok(LaxDate {
            year: Year::try_from(
                year_part
                    .parse::<u16>()
                    .map_err(|_| InvalidDate::InvalidYear)?,
            )?,
            month: parts
                .next()
                .and_then(|m| m.parse::<NonZeroU8>().ok())
                .filter(|&m| m.get() <= 12),
            day: parts
                .next()
                .and_then(|d| d.parse::<NonZeroU8>().ok())
                .filter(|&d| d.get() <= 31),
        })
    }
}

impl PartialOrd for LaxDate {
    fn partial_cmp(&self, other: &LaxDate) -> Option<Ordering> {
        let by_year = self.year.cmp(&other.year);
        if by_year.is_ne() {
            return Some(by_year);
        }

        let by_month = self.month?.cmp(&other.month?);
        if by_month.is_ne() {
            return Some(by_month);
        }

        Some(self.day?.cmp(&other.day?))
    }
}

impl PartialEq for LaxDate {
    fn eq(&self, other: &LaxDate) -> bool {
        self.partial_cmp(other) == Some(Ordering::Equal)
    }
}

impl fmt::Display for LaxDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}.", self.year.0)?;
        match self.month {
            Some(month) => write!(f, "{month:02}.")?,
            None => f.write_str("??.")?,
        }
        match self.day {
            Some(day) => write!(f, "{day:02}"),
            None => f.write_str("??"),
        }
    }
}

const MIN_YEAR: u16 = 1952;

const MAX_YEAR: u16 = 3000; // MAX_YEAR * 12 + 12 < 2^16

#[derive(Debug, Copy, Clone, Ord, PartialOrd, Eq, PartialEq, Hash)]
pub struct Year(u16);

impl Year {
    pub fn min_value() -> Year {
        Year(MIN_YEAR)
    }

    pub fn max_value() -> Year {
        Year(MAX_YEAR)
    }

    #[must_use]
    pub fn add_years_saturating(self, years: u16) -> Year {
        min(Year(self.0.saturating_add(years)), Year::max_value())
    }
}

impl From<Year> for u16 {
    fn from(Year(year): Year) -> u16 {
        year
    }
}

impl TryFrom<u16> for Year {
    type Error = InvalidDate;

    fn try_from(year: u16) -> Result<Year, InvalidDate> {
        if Year::min_value().0 <= year && year <= Year::max_value().0 {
            Ok(Year(year))
        } else {
            Err(InvalidDate::InvalidYear)
        }
    }
}

impl FromStr for Year {
    type Err = InvalidDate;

    fn from_str(s: &str) -> Result<Year, InvalidDate> {
        Year::try_from(s.parse::<u16>().map_err(|_| InvalidDate::InvalidYear)?)
    }
}

#[derive(Debug, Copy, Clone, Ord, PartialOrd, Eq, PartialEq, Hash)]
pub struct Month(u16);

impl Month {
    pub fn min_value() -> Month {
        Month(MIN_YEAR * 12)
    }

    pub fn max_value() -> Month {
        Month(MAX_YEAR * 12 + 11)
    }

    pub fn from_time_saturating(time: PrimitiveDateTime) -> Month {
        let year = time.year().clamp(MIN_YEAR as i32, MAX_YEAR as i32) as u16;
        let month0 = u16::from(u8::from(time.month()) - 1);
        Month(year * 12 + month0)
    }

    #[must_use]
    pub fn add_months_saturating(self, months: u16) -> Month {
        min(Month(self.0.saturating_add(months)), Month::max_value())
    }

    pub fn year(self) -> Year {
        Year(self.0 / 12)
    }
}

impl From<Month> for u16 {
    fn from(Month(month): Month) -> u16 {
        month
    }
}

impl TryFrom<u16> for Month {
    type Error = InvalidDate;

    fn try_from(month: u16) -> Result<Month, InvalidDate> {
        if Month::min_value().0 <= month && month <= Month::max_value().0 {
            Ok(Month(month))
        } else {
            Err(InvalidDate::InvalidMonth)
        }
    }
}

impl fmt::Display for Month {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}", self.0 / 12, self.0 % 12 + 1)
    }
}

impl FromStr for Month {
    type Err = InvalidDate;

    fn from_str(s: &str) -> Result<Month, InvalidDate> {
        match s.split_once(['-', '/']) {
            Some((year_part, month_part)) => {
                let year: u16 = year_part.parse().map_err(|_| InvalidDate::InvalidMonth)?;
                let month_plus_one: u16 =
                    month_part.parse().map_err(|_| InvalidDate::InvalidMonth)?;

                if (MIN_YEAR..=MAX_YEAR).contains(&year) && (1..=12).contains(&month_plus_one) {
                    Ok(Month(year * 12 + month_plus_one - 1))
                } else {
                    Err(InvalidDate::InvalidMonth)
                }
            }
            None => Err(InvalidDate::InvalidMonth),
        }
    }
}

#[cfg(test)]
mod tests {
    use quickcheck::{Arbitrary, Gen, quickcheck};

    use super::*;

    impl Arbitrary for Month {
        fn arbitrary(g: &mut Gen) -> Month {
            Month(
                u16::arbitrary(g)
                    % (u16::from(Month::max_value()) - u16::from(Month::min_value()) + 1)
                    + u16::from(Month::min_value()),
            )
        }
    }

    impl Arbitrary for Year {
        fn arbitrary(g: &mut Gen) -> Year {
            Year(u16::arbitrary(g) % (MAX_YEAR - MIN_YEAR + 1) + MIN_YEAR)
        }
    }

    impl Arbitrary for LaxDate {
        fn arbitrary(g: &mut Gen) -> LaxDate {
            LaxDate {
                year: Year::arbitrary(g),
                month: NonZeroU8::new(u8::arbitrary(g) % (12 + 1)),
                day: NonZeroU8::new(u8::arbitrary(g) % (31 + 1)),
            }
        }
    }

    #[test]
    fn test_tomorrow_str_roundtrip() {
        let tomorrow = LaxDate::tomorrow();
        let s = tomorrow.to_string();
        assert_eq!(LaxDate::from_str(&s).unwrap(), tomorrow);
    }

    quickcheck! {
        fn test_lax_date_str_roundtrip(date: LaxDate) -> bool {
            let s = date.to_string();
            LaxDate::from_str(&s).unwrap().to_string() == s
        }

        fn test_month_str_roundtrip(month: Month) -> bool {
            let s = month.to_string();
            Month::from_str(&s).unwrap() == month
        }

        fn test_lax_date_month_str(month: Month) -> bool {
            let s = month.to_string().replace('-', ".");
            let date = LaxDate::from_str(dbg!(&s)).unwrap();
            date.month().unwrap() == month
        }

        fn test_lax_date_partial_ord_transitivity(a: LaxDate, b: LaxDate, c: LaxDate) -> bool {
            !(a < b && b < c) || (a < c)
        }

        fn test_lax_date_partial_ord_duality(a: LaxDate, b: LaxDate) -> bool {
            (a < b) == (b > a)
        }
    }
}
