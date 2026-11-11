//! Glyph atlas allocator: shelf packing with whole-shelf eviction.
//!
//! The texture never changes size, so the GPU side never reallocates or copies
//! it. Glyphs are packed left to right on horizontal shelves. When the atlas is
//! full, the least recently used shelf that was not touched this frame is
//! cleared and reused whole; there is no per-glyph free list and so no
//! fragmentation. Every texel is RGBA8 (masks store white with coverage in
//! alpha), which lets one texture and one pipeline draw masks, colour emoji and
//! solid rectangles.
//!
//! The atlas keeps the CPU copy of its pixels and a list of rectangles written
//! since the last upload, so the GPU upload is only the new glyphs.

use std::collections::HashMap;
use std::hash::Hash;

/// A rectangle inside the atlas, in texels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
}

#[derive(Clone, Copy, Debug)]
struct Shelf {
    y: u16,
    h: u16,
    /// Next free x.
    x: u16,
    /// Frame in which any glyph on this shelf was last used.
    used_frame: u64,
    pinned: bool,
}

#[derive(Clone, Copy, Debug)]
struct Entry {
    rect: Rect,
    shelf: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AtlasStats {
    pub entries: usize,
    pub inserts: u64,
    pub hits: u64,
    pub evicted_shelves: u64,
    pub full_failures: u64,
    pub uploaded_bytes: u64,
}

pub struct Atlas<K> {
    width: u16,
    height: u16,
    shelves: Vec<Shelf>,
    map: HashMap<K, Entry>,
    pixels: Vec<u8>,
    dirty: Vec<Rect>,
    frame: u64,
    /// Bumped whenever a placed glyph's texels may be overwritten (shelf
    /// reuse, tail pop, clear). Instances built earlier may then point at
    /// stale texels, so a consumer that caches instances must rebuild them.
    epoch: u64,
    stats: AtlasStats,
}

/// Where the solid-white texel block lives. Solid rectangles sample it.
pub const WHITE: Rect = Rect {
    x: 0,
    y: 0,
    w: 2,
    h: 2,
};

impl<K: Hash + Eq + Copy> Atlas<K> {
    pub fn new(width: u16, height: u16) -> Self {
        assert!(width >= 4 && height >= 4);
        let mut atlas = Atlas {
            width,
            height,
            shelves: Vec::new(),
            map: HashMap::new(),
            pixels: vec![0; width as usize * height as usize * 4],
            dirty: Vec::new(),
            frame: 1,
            epoch: 0,
            stats: AtlasStats::default(),
        };
        // Pinned first shelf holding the white block.
        atlas.shelves.push(Shelf {
            y: 0,
            h: 4,
            x: WHITE.w,
            used_frame: u64::MAX,
            pinned: true,
        });
        let white = [255u8; 2 * 2 * 4];
        atlas.write(WHITE, &white);
        atlas
    }

    pub fn size(&self) -> (u16, u16) {
        (self.width, self.height)
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    pub fn stats(&self) -> AtlasStats {
        AtlasStats {
            entries: self.map.len(),
            ..self.stats
        }
    }

    /// Whether a `w x h` bitmap could ever be placed, even in an empty atlas.
    /// The pinned first shelf (the white block) is not available to it.
    pub fn can_ever_fit(&self, w: u16, h: u16) -> bool {
        w > 0 && h > 0 && w <= self.width && h <= self.height.saturating_sub(4)
    }

    /// Starts a frame. Glyphs used from now on are protected from eviction
    /// until the next call.
    pub fn begin_frame(&mut self) {
        self.frame += 1;
    }

    /// Looks a glyph up, marking it used this frame.
    pub fn get(&mut self, key: &K) -> Option<Rect> {
        let entry = *self.map.get(key)?;
        self.shelves[entry.shelf].used_frame = self.frame;
        self.stats.hits += 1;
        Some(entry.rect)
    }

    /// Packs an RGBA bitmap. Returns `None` when it cannot fit even after
    /// evicting everything not used this frame; the caller should then clear the
    /// atlas between frames (`clear`) and retry.
    pub fn insert(&mut self, key: K, w: u16, h: u16, rgba: &[u8]) -> Option<Rect> {
        debug_assert_eq!(rgba.len(), w as usize * h as usize * 4);
        if w == 0 || h == 0 {
            return None;
        }
        if let Some(rect) = self.get(&key) {
            return Some(rect);
        }
        let (rect, shelf) = match self.alloc(w, h) {
            Some(found) => found,
            None => {
                self.stats.full_failures += 1;
                return None;
            }
        };
        self.write(rect, rgba);
        self.map.insert(key, Entry { rect, shelf });
        self.shelves[shelf].used_frame = self.frame;
        self.stats.inserts += 1;
        Some(rect)
    }

    /// Drops every glyph (the white block stays). Marks nothing dirty: stale
    /// texels are never sampled because no instance refers to them.
    pub fn clear(&mut self) {
        self.epoch += 1;
        self.map.clear();
        self.shelves.truncate(1);
        self.shelves[0].x = WHITE.w;
    }

    /// Rectangles written since the last call, adjacent ones on a shelf merged.
    pub fn take_dirty(&mut self) -> Vec<Rect> {
        let mut rects = std::mem::take(&mut self.dirty);
        rects.sort_by_key(|r| (r.y, r.x));
        let mut merged: Vec<Rect> = Vec::new();
        for r in rects {
            match merged.last_mut() {
                Some(last) if last.y == r.y && last.h == r.h && last.x + last.w == r.x => {
                    last.w += r.w;
                }
                _ => merged.push(r),
            }
        }
        self.stats.uploaded_bytes += merged
            .iter()
            .map(|r| r.w as u64 * r.h as u64 * 4)
            .sum::<u64>();
        merged
    }

    fn write(&mut self, rect: Rect, rgba: &[u8]) {
        let stride = self.width as usize * 4;
        let row_bytes = rect.w as usize * 4;
        for row in 0..rect.h as usize {
            let dst = (rect.y as usize + row) * stride + rect.x as usize * 4;
            let src = row * row_bytes;
            self.pixels[dst..dst + row_bytes].copy_from_slice(&rgba[src..src + row_bytes]);
        }
        self.dirty.push(rect);
    }

    fn fits_shelf(shelf_h: u16, h: u16) -> bool {
        shelf_h >= h && shelf_h - h <= (h / 2).max(3)
    }

    fn alloc(&mut self, w: u16, h: u16) -> Option<(Rect, usize)> {
        if w > self.width || h > self.height {
            return None;
        }
        // 1. A shelf of the right height with room.
        let mut best: Option<usize> = None;
        for (i, s) in self.shelves.iter().enumerate() {
            if Self::fits_shelf(s.h, h)
                && s.x as u32 + w as u32 <= self.width as u32
                && best.map_or(true, |b| s.h < self.shelves[b].h)
            {
                best = Some(i);
            }
        }
        if let Some(i) = best {
            return Some(self.place(i, w, h));
        }
        // 2. A new shelf.
        if let Some(i) = self.new_shelf(h) {
            return Some(self.place(i, w, h));
        }
        // 3. Reclaim stale tail shelves, then try a new shelf again.
        loop {
            let last = *self.shelves.last().unwrap();
            if last.pinned || last.used_frame >= self.frame {
                break;
            }
            self.drop_shelf_entries(self.shelves.len() - 1);
            self.shelves.pop();
            self.stats.evicted_shelves += 1;
            if let Some(i) = self.new_shelf(h) {
                return Some(self.place(i, w, h));
            }
        }
        // 4. Reuse the least recently used stale shelf of a fitting height.
        let mut victim: Option<usize> = None;
        for (i, s) in self.shelves.iter().enumerate() {
            if !s.pinned
                && s.used_frame < self.frame
                && Self::fits_shelf(s.h, h)
                && victim.map_or(true, |v| s.used_frame < self.shelves[v].used_frame)
            {
                victim = Some(i);
            }
        }
        let v = victim?;
        self.drop_shelf_entries(v);
        self.shelves[v].x = 0;
        self.stats.evicted_shelves += 1;
        Some(self.place(v, w, h))
    }

    fn new_shelf(&mut self, h: u16) -> Option<usize> {
        let next_y = self
            .shelves
            .last()
            .map(|s| s.y as u32 + s.h as u32)
            .unwrap_or(0);
        if next_y + h as u32 > self.height as u32 {
            return None;
        }
        // Round heights up so shelves are reusable by slightly different glyphs.
        let rounded = h.div_ceil(4) * 4;
        let shelf_h = rounded.min((self.height as u32 - next_y) as u16);
        self.shelves.push(Shelf {
            y: next_y as u16,
            h: shelf_h,
            x: 0,
            used_frame: 0,
            pinned: false,
        });
        Some(self.shelves.len() - 1)
    }

    fn place(&mut self, shelf: usize, w: u16, h: u16) -> (Rect, usize) {
        let s = &mut self.shelves[shelf];
        let rect = Rect {
            x: s.x,
            y: s.y,
            w,
            h,
        };
        s.x += w;
        (rect, shelf)
    }

    fn drop_shelf_entries(&mut self, shelf: usize) {
        self.epoch += 1;
        self.map.retain(|_, e| e.shelf != shelf);
    }
}

/// Side length (a power of two, at least 512) of a square atlas that holds the
/// distinct glyphs of a busy screen. Budget: 4096 glyph cells (ASCII in a few
/// styles plus a screenful of CJK or symbols) with 25% packing waste, capped by
/// the device's `max_texture_dimension_2d` and by `u16`.
pub fn atlas_size_for(cell_w: u32, cell_h: u32, max_texture_dimension: u32) -> u16 {
    let area = 4096.0 * cell_w.max(1) as f64 * cell_h.max(1) as f64 * 1.25;
    let side = (area.sqrt().ceil() as u32).next_power_of_two().max(512);
    side.min(max_texture_dimension.max(4)).min(16384) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bitmap(w: u16, h: u16, v: u8) -> Vec<u8> {
        vec![v; w as usize * h as usize * 4]
    }

    #[test]
    fn white_block_is_reserved_and_dirty_once() {
        let mut a: Atlas<u32> = Atlas::new(64, 64);
        let dirty = a.take_dirty();
        assert_eq!(dirty, vec![WHITE]);
        assert_eq!(&a.pixels()[0..4], &[255, 255, 255, 255]);
        assert!(a.take_dirty().is_empty());
    }

    #[test]
    fn a_second_lookup_hits_and_uploads_nothing() {
        let mut a: Atlas<u32> = Atlas::new(64, 64);
        a.take_dirty();
        let r1 = a.insert(1, 8, 12, &bitmap(8, 12, 7)).unwrap();
        assert_eq!(a.take_dirty(), vec![r1]);
        let r2 = a.insert(1, 8, 12, &bitmap(8, 12, 7)).unwrap();
        assert_eq!(r1, r2);
        assert!(a.take_dirty().is_empty());
        assert_eq!(a.stats().inserts, 1);
    }

    #[test]
    fn glyphs_pack_onto_shelves_without_overlap() {
        let mut a: Atlas<u32> = Atlas::new(64, 64);
        let mut rects = Vec::new();
        for k in 0..20 {
            rects.push(a.insert(k, 8, 12, &bitmap(8, 12, 1)).unwrap());
        }
        for (i, x) in rects.iter().enumerate() {
            assert!(x.x + x.w <= 64 && x.y + x.h <= 64);
            for y in &rects[i + 1..] {
                let apart =
                    x.x + x.w <= y.x || y.x + y.w <= x.x || x.y + x.h <= y.y || y.y + y.h <= x.y;
                assert!(apart, "{x:?} overlaps {y:?}");
            }
            assert!(
                !(x.x < WHITE.w && x.y < WHITE.h),
                "overlaps the white block"
            );
        }
    }

    #[test]
    fn full_atlas_evicts_a_stale_shelf_and_never_grows() {
        let mut a: Atlas<u32> = Atlas::new(32, 32);
        // Fill with frame-1 glyphs.
        let mut k = 0;
        while a.insert(k, 8, 8, &bitmap(8, 8, 1)).is_some() {
            k += 1;
            if k > 1000 {
                panic!("atlas never filled");
            }
        }
        assert!(k > 4);
        // Same frame: still full, nothing evictable.
        assert!(a.insert(9999, 8, 8, &bitmap(8, 8, 2)).is_none());
        // Next frame: stale shelves can be reclaimed.
        a.begin_frame();
        let r = a
            .insert(9999, 8, 8, &bitmap(8, 8, 2))
            .expect("evicts a shelf");
        assert!(r.x + r.w <= 32 && r.y + r.h <= 32);
        assert!(a.stats().evicted_shelves >= 1);
        assert_eq!(a.size(), (32, 32));
    }

    #[test]
    fn glyphs_used_this_frame_survive_eviction() {
        let mut a: Atlas<u32> = Atlas::new(32, 32);
        let mut k = 0;
        while a.insert(k, 8, 8, &bitmap(8, 8, 1)).is_some() {
            k += 1;
        }
        a.begin_frame();
        // Touch glyph 0 so its shelf is protected.
        let keep = a.get(&0).unwrap();
        a.insert(5000, 8, 8, &bitmap(8, 8, 2)).unwrap();
        assert_eq!(a.get(&0), Some(keep));
    }

    #[test]
    fn adjacent_dirty_rects_merge_into_one_upload() {
        let mut a: Atlas<u32> = Atlas::new(64, 64);
        a.take_dirty();
        a.insert(1, 8, 12, &bitmap(8, 12, 1)).unwrap();
        a.insert(2, 8, 12, &bitmap(8, 12, 1)).unwrap();
        a.insert(3, 8, 12, &bitmap(8, 12, 1)).unwrap();
        let d = a.take_dirty();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].w, 24);
    }

    #[test]
    fn the_epoch_changes_only_when_texels_may_be_overwritten() {
        let mut a: Atlas<u32> = Atlas::new(32, 32);
        let e0 = a.epoch();
        let mut k = 0;
        while a.insert(k, 8, 8, &bitmap(8, 8, 1)).is_some() {
            k += 1;
        }
        assert_eq!(a.epoch(), e0, "plain inserts never move existing glyphs");
        a.begin_frame();
        a.insert(9999, 8, 8, &bitmap(8, 8, 2)).unwrap();
        assert!(a.epoch() > e0, "eviction must be visible to consumers");
        let e1 = a.epoch();
        a.clear();
        assert!(a.epoch() > e1);
    }

    #[test]
    fn can_ever_fit_accounts_for_the_pinned_shelf() {
        let a: Atlas<u32> = Atlas::new(32, 32);
        assert!(a.can_ever_fit(32, 28));
        assert!(!a.can_ever_fit(33, 4));
        assert!(!a.can_ever_fit(8, 29));
        assert!(!a.can_ever_fit(0, 4));
    }

    #[test]
    fn atlas_size_grows_with_the_cell_and_respects_the_device_limit() {
        assert_eq!(atlas_size_for(8, 18, 16384), 1024);
        assert_eq!(atlas_size_for(16, 36, 16384), 2048);
        assert_eq!(atlas_size_for(16, 36, 1024), 1024, "capped by the device");
        assert_eq!(atlas_size_for(2, 4, 16384), 512, "never below 512");
    }

    #[test]
    fn an_oversized_glyph_is_refused() {
        let mut a: Atlas<u32> = Atlas::new(16, 16);
        assert!(a.insert(1, 20, 4, &bitmap(20, 4, 1)).is_none());
    }
}
