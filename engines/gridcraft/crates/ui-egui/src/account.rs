//! The account a host page signed in with. UFile passes `?account=<name>&signout=<label>` to the
//! web build: the title bar then shows the person's initials (the name on hover) and a menu with
//! Sign out, which the web shell hands back to the page as `<prefix>:signout`.

use egui::{Align2, Color32, FontId, Response, RichText, Sense, Ui, vec2};

/// Who is signed in, as the host page says.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Account {
    pub name: String,
    /// The Sign out item, in the host's own words; empty: the menu has none.
    pub sign_out: String,
    /// Sign out was picked; the web shell passes it on and clears it.
    pub sign_out_requested: bool,
}

impl Account {
    /// Up to two initials: the first letter or digit of each of the first two words, upper case.
    pub fn initials(&self) -> String {
        self.name.split_whitespace().filter_map(|w| w.chars().find(|c| c.is_alphanumeric())).take(2).flat_map(char::to_uppercase).collect()
    }
}

/// The title bar's account button: a `size` circle in `fill` with the initials in `ink`, the name
/// on hover, and a menu with the name and Sign out on click.
pub fn button(ui: &mut Ui, account: &mut Account, size: f32, fill: Color32, ink: Color32, font: FontId) -> Response {
    let (r, resp) = ui.allocate_exact_size(vec2(size, size), Sense::click());
    let radius = size / 2.0 - 1.0;
    ui.painter().circle_filled(r.center(), radius, if resp.hovered() { fill.gamma_multiply(0.85) } else { fill });
    ui.painter().text(r.center(), Align2::CENTER_CENTER, account.initials(), font, ink);
    let resp = resp.on_hover_text(&account.name);
    egui::Popup::menu(&resp).show(|ui| {
        ui.label(RichText::new(&account.name).strong());
        if !account.sign_out.is_empty() {
            ui.separator();
            if ui.button(&account.sign_out).clicked() {
                account.sign_out_requested = true;
                ui.ctx().request_repaint();
                ui.close();
            }
        }
    });
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initials_are_the_first_letters_of_the_first_two_words() {
        let a = |name: &str| Account { name: name.into(), ..Default::default() }.initials();
        assert_eq!(a("Aziz Karimov"), "AK");
        assert_eq!(a("  o'tkir  hoshimov  jr "), "OH");
        assert_eq!(a("Тошпўлат"), "Т");
        assert_eq!(a("(Ali) Valiyev"), "AV");
        assert_eq!(a(""), "");
    }
}
