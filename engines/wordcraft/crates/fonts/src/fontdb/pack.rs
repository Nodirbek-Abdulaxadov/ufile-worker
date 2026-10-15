//! Families the host serves on demand (UFile's font pack): open fonts that stand in for the Office
//! fonts under the Office names (Liberation Sans as Arial, Carlito as Calibri…), with the same
//! metrics, so documents lay out as in Word. The host offers them ([`FontDb::offer_families`]) and
//! the font list shows them before they are loaded. The first time layout asks for one, the host
//! is asked to fetch it; when its files arrive ([`FontDb::add_pack_font`]) the faces join the
//! database under the offered name and [`FontDb::generation`] moves, so layouts are redone.

use std::collections::HashSet;
use std::sync::Arc;

use super::{FontBytes, FontDb, enumerate_faces, legacy_family, make_face};

#[derive(Default)]
pub(super) struct Pack {
    /// The families offered, as the host names them.
    offered: Vec<String>,
    /// The families asked for (lower case): each is fetched once.
    requested: HashSet<String>,
    fetch: Option<fn(&str)>,
}

impl FontDb {
    fn write_pack(&self) -> std::sync::RwLockWriteGuard<'_, Pack> {
        self.pack.write().unwrap_or_else(|e| e.into_inner())
    }

    /// Offer `families` for fetching on demand: they join the font list, and the first lookup of
    /// one that isn't loaded calls `fetch` with its name (once per family). `fetch` only starts
    /// the download; the files come back through [`FontDb::add_pack_font`].
    pub fn offer_families(&self, families: Vec<String>, fetch: fn(&str)) {
        let mut pack = self.write_pack();
        pack.offered = families;
        pack.fetch = Some(fetch);
        drop(pack);
        self.fonts_changed();
    }

    /// The families offered for fetching on demand, loaded or not.
    pub fn offered_families(&self) -> Vec<String> {
        self.pack.read().unwrap_or_else(|e| e.into_inner()).offered.clone()
    }

    /// Is `family` offered for fetching and not loaded yet?
    pub fn is_offered(&self, family: &str) -> bool {
        self.pack.read().unwrap_or_else(|e| e.into_inner()).offered.iter().any(|f| f.eq_ignore_ascii_case(family)) && !self.is_loaded(family)
    }

    /// Ask the host for `family` if it is offered and hasn't been asked for.
    pub fn want(&self, family: &str) {
        if !self.is_offered(family) {
            return;
        }
        let call = {
            let mut pack = self.write_pack();
            let Some(name) = pack.offered.iter().find(|f| f.eq_ignore_ascii_case(family)).cloned() else { return };
            if !pack.requested.insert(name.to_lowercase()) {
                return;
            }
            pack.fetch.map(|f| (f, name))
        };
        if let Some((fetch, name)) = call {
            fetch(&name);
        }
    }

    /// Add a font file of the offered `family`: its faces are named `family`, whatever the file
    /// calls itself, and keep their styles. Faces of a style the family already has are skipped.
    /// Returns how many faces were added.
    pub fn add_pack_font(&self, family: &str, bytes: Vec<u8>) -> Result<usize, String> {
        let data = Arc::new(super::decode_font_file(&bytes).map_err(|e| e.to_string())?);
        let found = enumerate_faces(&data);
        if found.is_empty() {
            return Err(format!("{family}: no usable face"));
        }
        let mut new = Vec::new();
        for f in found {
            let legacy = legacy_family(family, &f.style);
            let face = make_face(FontBytes::Owned(data.clone()), f.index, family.to_string(), f.style, legacy, f.coords)
                .ok_or_else(|| format!("{family}: a face doesn't parse"))?;
            new.push(Arc::new(face));
        }
        let added = {
            let mut faces = self.faces.write().unwrap_or_else(|e| e.into_inner());
            let fresh: Vec<_> = new
                .into_iter()
                .filter(|f| !faces.iter().any(|g| g.family.eq_ignore_ascii_case(&f.family) && g.style.eq_ignore_ascii_case(&f.style)))
                .collect();
            let n = fresh.len();
            faces.extend(fresh);
            n
        };
        if added > 0 {
            self.fonts_changed();
        }
        Ok(added)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fetched(_: &str) {}

    #[test]
    fn a_pack_font_joins_under_the_offered_name() {
        let db = FontDb::with_font_dirs(Vec::new());
        db.offer_families(vec!["Pack Sans".into()], fetched);
        assert!(db.families().iter().any(|f| f == "Pack Sans"), "offered families are listed before they load");
        assert!(db.is_offered("pack sans"));
        let gen0 = db.generation();
        let n = db.add_pack_font("Pack Sans", super::super::BUNDLED[0].to_vec()).expect("the font loads");
        assert_eq!(n, 1);
        assert!(db.generation() > gen0);
        assert!(db.is_loaded("Pack Sans") && !db.is_offered("Pack Sans"));
        assert_eq!(db.face("Pack Sans", "Regular").family, "Pack Sans");
        // The same face again adds nothing.
        assert_eq!(db.add_pack_font("Pack Sans", super::super::BUNDLED[0].to_vec()), Ok(0));
    }
}
